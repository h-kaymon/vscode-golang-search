import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as util from 'util';
import { getWebviewContent } from './webview';

// Declare console object to resolve type errors
declare var console: {
    log(message?: any, ...optionalParams: any[]): void;
    error(message?: any, ...optionalParams: any[]): void;
    warn(message?: any, ...optionalParams: any[]): void;
    info(message?: any, ...optionalParams: any[]): void;
};

// Convert exec to Promise form
const execPromise = util.promisify(cp.exec);

// Get Go module cache path
async function getGoModCachePath(): Promise<string> {
    try {
        const { stdout } = await execPromise('go env GOMODCACHE');
        return stdout.trim();
    } catch (error) {
        console.error('get GOMODCACHE failed:', error);
        // Return default path on failure
        return path.join(os.homedir(), 'go', 'pkg', 'mod');
    }
}

// Get project dependencies
async function getProjectDependencies(workspaceDir: string): Promise<string[]> {
    try {
        // Ensure command runs in workspace directory
        const options = { cwd: workspaceDir };
        const { stdout } = await execPromise('go list -m all', options);
        
        // Parse output, remove main module (first line)
        const modules = stdout.split('\n').filter(Boolean);
        if (modules.length > 0) {
            // First module is usually the project itself
            return modules.slice(1);
        }
        return [];
    } catch (error) {
        console.error('get project dependencies failed:', error);
        return [];
    }
}

// Define search result source type
enum ResultSource {
    Dependency = 'dependency',
    Workspace = 'workspace'
}

// Define search result type
interface SearchResult {
    location: vscode.Location;
    content: string;
    source: ResultSource; // Mark if result is from dependency or workspace
}

// Global storage for search results
let lastSearchResults: SearchResult[] = [];
let lastSearchText: string = '';

// Search view provider - Using WebviewView to implement search box
class GoSearchWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'golang-search-results';
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _searchResultsProvider: GoSearchResultsProvider;
    
    constructor(
        extensionUri: vscode.Uri,
        private readonly searchResultsProvider: GoSearchResultsProvider
    ) {
        this._extensionUri = extensionUri;
        this._searchResultsProvider = searchResultsProvider;
    }
    
    resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };
        
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        
        // Listen for messages from Webview
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'search':
                    const searchText = data.text;
                    if (searchText && searchText.length >= 3) {
                        await this.performSearch(searchText);
                    }
                    break;
                case 'openFile':
                    const filePath = data.filePath;
                    const line = data.line;
                    const column = data.column || 0;
                    
                    const uri = vscode.Uri.file(filePath);
                    const position = new vscode.Position(line, column);
                    const location = new vscode.Location(uri, position);
                    
                    vscode.commands.executeCommand('golang-search.openFile', location);
                    break;
            }
        });
    }
    
    // Execute search and update results
    private async performSearch(searchText: string) {
        if (!this._view) {
            return;
        }
        
        this._view.webview.postMessage({ command: 'searchStarted' });
        
        try {
            // Get current workspace
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                this._view.webview.postMessage({ 
                    command: 'searchError', 
                    message: 'Please open a Go project workspace first' 
                });
                return;
            }
            
            const workspaceDir = workspaceFolders[0].uri.fsPath;
            const goModPath = path.join(workspaceDir, 'go.mod');
            
            if (!fs.existsSync(goModPath)) {
                this._view.webview.postMessage({ 
                    command: 'searchError', 
                    message: 'current workspace is not a valid Go module project' 
                });
                return;
            }
            
                            // Search both workspace and dependencies
                const [workspaceResults, dependencyResults] = await Promise.all([
                    searchInWorkspace(workspaceDir, searchText),
                    searchInDependencies(workspaceDir, searchText)
                ]);
                
                // Sort each result set separately, prioritizing non-test files
                const sortWorkspaceResults = (a: SearchResult, b: SearchResult) => {
                    const aIsTest = a.location.uri.fsPath.endsWith('_test.go');
                    const bIsTest = b.location.uri.fsPath.endsWith('_test.go');
                    if (aIsTest && !bIsTest) return 1;
                    if (!aIsTest && bIsTest) return -1;
                    return 0;
                };
                
                // Ensure results are sorted with non-test files first within each group
                const sortedWorkspaceResults = [...workspaceResults].sort(sortWorkspaceResults);
                const sortedDependencyResults = [...dependencyResults].sort(sortWorkspaceResults);
                
                // Combine results - workspace first, with non-test files prioritized in each group
                const results = [...sortedWorkspaceResults, ...sortedDependencyResults];
                
                // Save search results for tree view
                lastSearchResults = results;
                lastSearchText = searchText;
            
            // Refresh tree view
            this._searchResultsProvider.refresh();
            vscode.commands.executeCommand('setContext', 'golang-search.hasResults', true);
            
            // Format results and send to webview
            const goModCachePath = await getGoModCachePath();
            const formattedResults = results.map(result => {
                const location = result.location;
                const filePath = location.uri.fsPath;
                const fileName = path.basename(filePath);
                const lineNumber = location.range.start.line + 1;
                
                // Simplify file path by removing Go module cache prefix
                let simplifiedPath = filePath;
                const prefixToRemove = goModCachePath + '/';
                if (result.source === ResultSource.Dependency && simplifiedPath.startsWith(prefixToRemove)) {
                    simplifiedPath = simplifiedPath.substring(prefixToRemove.length);
                }
                
                return {
                    content: result.content,
                    fileName: fileName,
                    lineNumber: lineNumber,
                    filePath: filePath,
                    simplifiedPath: simplifiedPath,
                    source: result.source
                };
            });
            
            // 发送结果给webview
            this._view.webview.postMessage({ 
                command: 'searchResults', 
                results: formattedResults,
                searchText: searchText
            });
            
        } catch (error) {
            console.error('搜索错误:', error);
            this._view.webview.postMessage({ 
                command: 'searchError', 
                message: `搜索错误: ${error}` 
            });
        }
    }
    
             // Generate Webview HTML content
    private _getHtmlForWebview(webview: vscode.Webview): string {
        return getWebviewContent(lastSearchText);
    }
}

// provider for search results tree view
class GoSearchResultsProvider implements vscode.TreeDataProvider<SearchResultItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SearchResultItem | undefined | null | void> = new vscode.EventEmitter<SearchResultItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SearchResultItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SearchResultItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SearchResultItem): Thenable<SearchResultItem[]> {
        if (element) {
            // if has parent element, return its children (currently no hierarchy, so return empty array)
            return Promise.resolve([]);
        }

        // return root level items
        if (lastSearchResults.length === 0) {
            // if no search results, show a prompt message
            const noResultsItem = new SearchResultItem(
                "click here to start search",
                vscode.TreeItemCollapsibleState.None,
                undefined,
                {
                    command: 'golang-search.searchInDeps',
                    title: 'start search'
                }
            );
            noResultsItem.iconPath = new vscode.ThemeIcon('search');
            return Promise.resolve([noResultsItem]);
        }

        // separate workspace and dependency results
        const workspaceResults = lastSearchResults.filter(r => r.source === ResultSource.Workspace);
        const dependencyResults = lastSearchResults.filter(r => r.source === ResultSource.Dependency);
        
        // create title items
        const items: SearchResultItem[] = [];
        
        // add search info header
        const searchInfoItem = new SearchResultItem(
            `search: "${lastSearchText}" (${lastSearchResults.length} results)`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            {
                command: 'golang-search.searchInDeps',
                title: 're-search'
            }
        );
        searchInfoItem.contextValue = 'searchInfo';
        items.push(searchInfoItem);
        
        // add workspace results
        if (workspaceResults.length > 0) {
            const workspaceHeader = new SearchResultItem(
                `workspace (${workspaceResults.length})`,
                vscode.TreeItemCollapsibleState.Expanded
            );
            workspaceHeader.contextValue = 'workspaceHeader';
            items.push(workspaceHeader);
            
            workspaceResults.forEach(result => {
                const filePath = result.location.uri.fsPath;
                const fileName = path.basename(filePath);
                const lineNumber = result.location.range.start.line + 1;
                
                const item = new SearchResultItem(
                    `${fileName}:${lineNumber}`,
                    vscode.TreeItemCollapsibleState.None,
                    result.content,
                    {
                        command: 'golang-search.openFile',
                        title: 'open file',
                        arguments: [result.location]
                    }
                );
                item.resourceUri = result.location.uri;
                item.contextValue = 'searchResult';
                items.push(item);
            });
        }
        
        // add dependency results
        if (dependencyResults.length > 0) {
            const depHeader = new SearchResultItem(
                `dependencies (${dependencyResults.length})`,
                vscode.TreeItemCollapsibleState.Expanded
            );
            depHeader.contextValue = 'dependencyHeader';
            items.push(depHeader);
            
            dependencyResults.forEach(result => {
                const filePath = result.location.uri.fsPath;
                const fileName = path.basename(filePath);
                const lineNumber = result.location.range.start.line + 1;
                
                const item = new SearchResultItem(
                    `${fileName}:${lineNumber}`,
                    vscode.TreeItemCollapsibleState.None,
                    result.content,
                    {
                        command: 'golang-search.openFile',
                        title: 'open file',
                        arguments: [result.location]
                    }
                );
                item.resourceUri = result.location.uri;
                item.iconPath = new vscode.ThemeIcon('library');
                item.contextValue = 'searchResultDependency';
                items.push(item);
            });
        }
        
        return Promise.resolve(items);
    }
}

// search result tree item
class SearchResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly description?: string,
        public readonly command?: vscode.Command
    ) {
        super(label, collapsibleState);
        this.tooltip = description || label;
        this.description = description;
    }
}

// search workspace items
async function searchInWorkspace(workspaceDir: string, searchText: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    try {
        // First check if directory exists
        if (!fs.existsSync(workspaceDir)) {
            console.log('workspace directory not found:', workspaceDir);
            return results;
        }
        
        // Check if directory has .go files
        try {
            // Use find command to check if Go files exist
            const checkCommand = `find "${workspaceDir}" -name "*.go" -type f -print -quit`;
            const { stdout: checkResult } = await execPromise(checkCommand);
            
            if (!checkResult.trim()) {
                console.log('workspace has no Go files:', workspaceDir);
                return results;
            }
        } catch (checkError) {
            console.log('check Go files failed:', checkError);
            // Continue trying to search, even if check failed
        }
        
        // Run grep command in workspace directory
        try {
            const grepCommand = `grep -rn "${searchText}" --include="*.go" "${workspaceDir}"`;
            
            const { stdout } = await execPromise(grepCommand);
            if (!stdout.trim()) {
                // No search results
                return results;
            }
            
            const lines = stdout.split('\n').filter(Boolean);
            const nonTestResults: SearchResult[] = [];
            const testResults: SearchResult[] = [];
            
            for (const line of lines) {
                // Try to match format with line numbers: file path:line number:content
                const match = line.match(/^(.+):(\d+):(.*)/);
                if (match) {
                    const [, filePath, lineStr, content] = match;
                    const lineNumber = parseInt(lineStr, 10) - 1; // VSCode line numbers start at 0
                    const uri = vscode.Uri.file(filePath);
                    const position = new vscode.Position(lineNumber, 0);
                    const range = new vscode.Range(position, position);
                    
                    // Create an object containing position, content, and source
                    const locationWithContent = {
                        location: new vscode.Location(uri, range),
                        content: content.trim(),
                        source: ResultSource.Workspace // Mark as workspace source
                    };
                    
                    // Check if file is a test file (ends with _test.go)
                    if (filePath.endsWith('_test.go')) {
                        testResults.push(locationWithContent);
                    } else {
                        nonTestResults.push(locationWithContent);
                    }
                    
                    // If total results exceed 50, stop adding
                    if (nonTestResults.length + testResults.length >= 50) {
                        break;
                    }
                }
            }
            
            // Add non-test file results first, then test file results
            results.push(...nonTestResults, ...testResults);
            // Limit results to 50
            return results.slice(0, 50);
            
        } catch (grepError) {
            // It's normal for grep to return an error when there are no results
            console.log('grep search results are empty or error:', grepError);
            // Return empty results on error
            return results;
        }
    } catch (error) {
        console.log('workspace search failed:', error);
    }
    
    return results;
}

// Search content in dependencies
async function searchInDependencies(workspaceDir: string, searchText: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const nonTestResults: SearchResult[] = [];
    const testResults: SearchResult[] = [];
    
    try {
        const goModCachePath = await getGoModCachePath();
        if (!goModCachePath || !fs.existsSync(goModCachePath)) {
            console.log('Go module cache path not found:', goModCachePath);
            return results;
        }
        
        const dependencies = await getProjectDependencies(workspaceDir);
        if (dependencies.length === 0) {
            console.log('project has no dependencies');
            return results;
        }
        
        // Iterate through all dependencies
        for (const dep of dependencies) {
            const [moduleName, version] = dep.split(' ');
            if (!version) continue;
            
            // Build module path in cache
            const modulePath = path.join(goModCachePath, `${moduleName}@${version}`);
            if (fs.existsSync(modulePath)) {
                // Use go tools to search for keywords in dependencies
                try {
                    // Run grep command in module directory - use quotes to handle spaces and special characters
                    const grepCommand = `grep -rn "${searchText}" --include="*.go" "${modulePath}"`;
                    
                    const { stdout } = await execPromise(grepCommand);
                    if (!stdout.trim()) {
                        // No search results
                        continue;
                    }
                    
                    const topLines = stdout.split('\n').filter(Boolean);
                    for (const line of topLines) {
                        
                        // Try to match format with line numbers: file path:line number:content
                        const match = line.match(/^(.+):(\d+):(.*)/);
                        if (match) {
                            const [, filePath, lineStr, content] = match;
                            const lineNumber = parseInt(lineStr, 10) - 1; // VSCode line numbers start at 0
                            const uri = vscode.Uri.file(filePath);
                            const position = new vscode.Position(lineNumber, 0);
                            const range = new vscode.Range(position, position);
                            
                            // Create an object containing position, content, and source
                            const locationWithContent = {
                                location: new vscode.Location(uri, range),
                                content: content.trim(),
                                source: ResultSource.Dependency // Mark as dependency source
                            };
                            
                            // Check if file is a test file (ends with _test.go)
                            if (filePath.endsWith('_test.go')) {
                                testResults.push(locationWithContent);
                            } else {
                                nonTestResults.push(locationWithContent);
                            }
                            
                            // If total results reach 50, stop adding
                            if (nonTestResults.length + testResults.length >= 50) {
                                // Prioritize non-test files
                                results.push(...nonTestResults, ...testResults);
                                return results.slice(0, 50); 
                            }
                        }
                    }
                } catch (error) {
                    // It's normal for grep to return an error when there are no results
                    // console.log(`No matches found in module ${moduleName}:`, error);
                }
            } else {
                // Module path doesn't exist, skip
                // console.log(`Module path doesn't exist: ${modulePath}`);
            }
        }
        
        // Prioritize non-test file results
        results.push(...nonTestResults, ...testResults);
        return results.slice(0, 50);
        
    } catch (error) {
        console.error('search dependencies failed:', error);
    }
    
    return results;
}

export function activate(context: vscode.ExtensionContext) {
    // Initialize context variable, even if no search results
    vscode.commands.executeCommand('setContext', 'golang-search.hasResults', false);
    
    // Create tree view provider (kept for compatibility)
    const searchResultsProvider = new GoSearchResultsProvider();
    
    // Create Webview view provider
    const webviewProvider = new GoSearchWebviewProvider(context.extensionUri, searchResultsProvider);
    
    // Register Webview view
    const searchResultsWebview = vscode.window.registerWebviewViewProvider(
        GoSearchWebviewProvider.viewType,
        webviewProvider,
        {
            webviewOptions: {
                retainContextWhenHidden: true,  // Retain Webview state to improve user experience
            }
        }
    );
    
    // Register command: Open file
    const openFileCommand = vscode.commands.registerCommand('golang-search.openFile', async (location: vscode.Location) => {
        try {
            if (!location || !location.uri) {
                vscode.window.showErrorMessage('invalid file location');
                return;
            }
            
            const document = await vscode.workspace.openTextDocument(location.uri);
            const editor = await vscode.window.showTextDocument(document);
            
            // 跳转到对应行
            const range = location.range;
            editor.selection = new vscode.Selection(range.start, range.start);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch (error) {
            vscode.window.showErrorMessage(`cannot open file: ${error}`);
        }
    });
    
    // Register command: Refresh view
    const refreshViewCommand = vscode.commands.registerCommand('golang-search.refreshView', () => {
        searchResultsProvider.refresh();
    });
    
    // Register command: Clear search results
    const clearResultsCommand = vscode.commands.registerCommand('golang-search.clearResults', () => {
        lastSearchResults = [];
        lastSearchText = '';
        searchResultsProvider.refresh();
        vscode.commands.executeCommand('setContext', 'golang-search.hasResults', false);
    });
    
    // Add commands and views to context
    context.subscriptions.push(
        openFileCommand,
        refreshViewCommand,
        clearResultsCommand,
        searchResultsWebview
    );
    
    // Register search command
    const searchCommand = vscode.commands.registerCommand('golang-search.searchInDeps', async () => {
        // Get current workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Please open a Go project workspace first');
            return;
        }
        
        // check if it is a Go project (exists go.mod file)
        const workspaceDir = workspaceFolders[0].uri.fsPath;
        const goModPath = path.join(workspaceDir, 'go.mod');
        
        if (!fs.existsSync(goModPath)) {
            vscode.window.showErrorMessage('current workspace is not a valid Go module project');
            return;
        }
        
        // create QuickPick for real-time search
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = 'search in Go dependencies';
        quickPick.title = 'input keyword to search';
        quickPick.busy = false;
        quickPick.canSelectMany = false;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        
        // add debounce function to avoid frequent search
        let debounceTimeout: NodeJS.Timeout | null = null;
        
        // listen for input changes
        quickPick.onDidChangeValue((value) => {
            console.log('input changed:', value);
            
            if (value.length < 3) {
                quickPick.items = [];
                quickPick.busy = false;
                return; // at least 3 characters to start search
            }
            
            // set busy status
            quickPick.busy = true;
            
            // cancel previous delay execution
            if (debounceTimeout) {
                clearTimeout(debounceTimeout);
            }
            
            // set delay execution of search (300ms debounce)
            debounceTimeout = setTimeout(async () => {
                try {            
                    // search workspace and dependencies
                    const [workspaceResults, dependencyResults] = await Promise.all([
                        searchInWorkspace(workspaceDir, value),
                        searchInDependencies(workspaceDir, value)
                    ]);
                    
                    // sort each result set separately, non-test files first
                    const sortWorkspaceResults = (a: SearchResult, b: SearchResult) => {
                        const aIsTest = a.location.uri.fsPath.endsWith('_test.go');
                        const bIsTest = b.location.uri.fsPath.endsWith('_test.go');
                        if (aIsTest && !bIsTest) return 1;
                        if (!aIsTest && bIsTest) return -1;
                        return 0;
                    };
                    
                    // ensure result set is sorted by non-test files first
                    const sortedWorkspaceResults = [...workspaceResults].sort(sortWorkspaceResults);
                    const sortedDependencyResults = [...dependencyResults].sort(sortWorkspaceResults);
                    
                    // prioritize workspace results, then dependency results, non-test files first in each group
                    const topResults = [...sortedWorkspaceResults, ...sortedDependencyResults];
                    
                    // save search results for sidebar display
                    lastSearchResults = [...workspaceResults, ...dependencyResults];
                    lastSearchText = value;
                    
                    // update sidebar view
                    vscode.commands.executeCommand('setContext', 'golang-search.hasResults', true);
                    searchResultsProvider.refresh();
                    
                    // get Go module cache path for simplified file path
                    const goModCachePath = await getGoModCachePath();
                    const prefixToRemove = goModCachePath + '/';
                    
                    // convert to QuickPickItem format
                    const items = topResults.map(result => {
                        const location = result.location;
                        const filePath = location.uri.fsPath;
                        const fileName = path.basename(filePath);
                        
                        // simplify file path, remove Go module cache path prefix
                        let simplifiedPath = filePath;
                        if (result.source === ResultSource.Dependency && simplifiedPath.startsWith(prefixToRemove)) {
                            simplifiedPath = simplifiedPath.substring(prefixToRemove.length);
                        }
                        
                        // add deep yellow background to dependency search results
                        const item: vscode.QuickPickItem = {
                            label: result.content,
                            description: `${fileName}:${location.range.start.line + 1}`,
                            detail: simplifiedPath,
                        };
                        
                        // add custom field
                        (item as any).location = location;
                        
                        // set style for dependency results
                        if (result.source === ResultSource.Dependency) {
                            // add multiple color indicators to label
                            item.label = `[library] $(symbol-color) $(debug-stackframe-dot) ${result.content}`;
                            
                            // add obvious yellow mark
                            item.description = `$(symbol-color) ${item.description}`;
                            
                            // add additional color hint to detail
                            item.detail = `$(debug-breakpoint-function-unverified) ${item.detail}`;
                            
                            // set icon button
                            (item as any).buttons = [{ 
                                iconPath: new vscode.ThemeIcon('library'),
                                tooltip: 'library results'
                            }];
                        }
                        
                        return item;
                    });
                    
                    // use alwaysShow property to ensure workspace results are always in front
                    const workspaceItems = items.filter((item: any) => 
                        item.location && !(item.label.startsWith('[library]'))
                    ).map(item => {
                        // set alwaysShow = true to ensure workspace results are always in front
                        return {
                            ...item,
                            alwaysShow: true,
                            // add special mark to indicate this is a workspace result
                            label: `${item.label}`
                        };
                    });
                    
                    const dependencyItems = items.filter((item: any) => 
                        item.location && item.label.startsWith('[library]')
                    );
                    
                    // recombine results
                    const sortedItems = [...workspaceItems, ...dependencyItems];
                    
                    // update search results
                    quickPick.items = sortedItems;        
                    
                    if (sortedItems.length === 0) {
                        quickPick.items = [{ label: `no results found for "${value}"` }];
                    }
                    
                } catch (error) {
                    console.error('search error:', error);
                    quickPick.items = [{ label: `search error: ${error}` }];
                } finally {
                    quickPick.busy = false;
                }
            }, 300);
        });
        
        // listen for selection changes (single click to open file)
        quickPick.onDidChangeSelection(async (items) => {
            const selected = items[0] as any;
            if (selected && selected.location) {
                try {
                    // check if file exists and path is valid
                    const filePath = selected.location.uri.fsPath;
                    if (!filePath || !fs.existsSync(filePath)) {
                        console.log('file not found or path is invalid:', filePath);
                        vscode.window.showErrorMessage(`file not found or cannot be accessed: ${path.basename(filePath || '')}`);
                        return;
                    }
                    
                    // check file type and open file
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile()) {
                        console.log('path is not a valid file:', filePath);
                        vscode.window.showErrorMessage(`path is not a valid file: ${path.basename(filePath)}`);
                        return;
                    }
                    
                    // open selected file
                    const document = await vscode.workspace.openTextDocument(selected.location.uri);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    // jump to corresponding line
                    const range = selected.location.range;
                    editor.selection = new vscode.Selection(range.start, range.start);
                    editor.revealRange(range);
                    
                    // close QuickPick
                    quickPick.dispose();
                } catch (error) {
                    console.error('open file failed:', error);
                    vscode.window.showErrorMessage(`cannot open file: ${error}`);
                }
            }
        });
        
        // handle double click (confirm selection)
        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0] as any;
            if (selected && selected.location) {
                try {
                    // check if file exists and path is valid
                    const filePath = selected.location.uri.fsPath;
                    if (!filePath || !fs.existsSync(filePath)) {
                        console.log('file not found or path is invalid:', filePath);
                        vscode.window.showErrorMessage(`file not found or cannot be accessed: ${path.basename(filePath || '')}`);
                        return;
                    }
                    
                    // check file type and open file
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile()) {
                        console.log('path is not a valid file:', filePath);
                        vscode.window.showErrorMessage(`path is not a valid file: ${path.basename(filePath)}`);
                        return;
                    }
                    
                    // open selected file
                    const document = await vscode.workspace.openTextDocument(selected.location.uri);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    // jump to corresponding line
                    const range = selected.location.range;
                    editor.selection = new vscode.Selection(range.start, range.start);
                    editor.revealRange(range);
                    
                    // close QuickPick
                    quickPick.dispose();
                } catch (error) {
                    console.error('open file failed:', error); 
                    vscode.window.showErrorMessage(`cannot open file: ${error}`);
                }
            }
        });
        
        // set initial items
        quickPick.items = [
            {
                label: 'input search keyword...',
                description: 'at least 3 characters to start search',
                detail: ''
            }
        ];
        quickPick.show();
    });
    
    context.subscriptions.push(searchCommand);
    
    // manually refresh once the tree view
    searchResultsProvider.refresh();
    
    // ensure view is visible
    vscode.commands.executeCommand('workbench.view.extension.golang-search');
}



export function deactivate() {} 