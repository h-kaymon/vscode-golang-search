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

// Check if ripgrep is available on the system
async function isRipgrepAvailable(): Promise<boolean> {
    try {
        await execPromise('rg --version');
        return true;
    } catch (error) {
        console.log('ripgrep not found, will use grep as fallback');
        return false;
    }
}

// Global variable to cache ripgrep availability
let ripgrepAvailable: boolean | null = null;

// Get ripgrep availability (cached)
async function getRipgrepAvailability(): Promise<boolean> {
    if (ripgrepAvailable === null) {
        ripgrepAvailable = await isRipgrepAvailable();
    }
    return ripgrepAvailable;
}

// Parallel search utility - limit concurrent executions
class ParallelSearchManager {
    private running = 0;
    private queue: Array<() => Promise<any>> = [];
    private maxConcurrent: number;

    constructor(maxConcurrent: number = 6) {
        this.maxConcurrent = Math.max(1, Math.min(20, maxConcurrent)); // Ensure reasonable bounds
        console.log(`Initialized ParallelSearchManager with ${this.maxConcurrent} max concurrent searches`);
    }

    async execute<T>(task: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            const wrappedTask = async () => {
                try {
                    this.running++;
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    this.running--;
                    this.processQueue();
                }
            };

            if (this.running < this.maxConcurrent) {
                wrappedTask();
            } else {
                this.queue.push(wrappedTask);
            }
        });
    }

    private processQueue() {
        if (this.queue.length > 0 && this.running < this.maxConcurrent) {
            const task = this.queue.shift();
            if (task) {
                task();
            }
        }
    }

    getStatus(): { running: number, queued: number, maxConcurrent: number } {
        return {
            running: this.running,
            queued: this.queue.length,
            maxConcurrent: this.maxConcurrent
        };
    }
}

// Global parallel search manager
let searchManager: ParallelSearchManager;

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

// Get Go standard library source path
async function getGoRootSrcPath(): Promise<string> {
    try {
        const { stdout } = await execPromise('go env GOROOT');
        const goRoot = stdout.trim();
        return path.join(goRoot, 'src');
    } catch (error) {
        console.error('get GOROOT failed:', error);
        // Return empty string if failed
        return '';
    }
}

// Get Go source path (only GOROOT/src)
async function getGoSourcePaths(): Promise<Array<{ path: string, name: string }>> {
    const sourcePaths: Array<{ path: string, name: string }> = [];

    try {
        const { stdout } = await execPromise('go env GOROOT');
        const goRoot = stdout.trim();

        // Only include GOROOT/src - contains all standard library and tools
        const srcPath = path.join(goRoot, 'src');
        if (fs.existsSync(srcPath)) {
            sourcePaths.push({
                path: srcPath,
                name: 'Go Source Code'
            });
        }

    } catch (error) {
        console.error('get Go source paths failed:', error);
    }

    return sourcePaths;
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
    Workspace = 'workspace',
    Stdlib = 'stdlib'
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

            // Initialize search manager if not exists
            const config = vscode.workspace.getConfiguration('golang-search');
            const maxConcurrent = config.get<number>('maxConcurrentSearches', 6);
            if (!searchManager) {
                searchManager = new ParallelSearchManager(maxConcurrent);
            }

            // Use parallel ripgrep/grep search
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
            const goSourcePaths = await getGoSourcePaths();
            const formattedResults = results.map(result => {
                const location = result.location;
                const filePath = location.uri.fsPath;
                const fileName = path.basename(filePath);
                const lineNumber = location.range.start.line + 1;

                // Determine result type and simplify file path
                let simplifiedPath = filePath;
                let resultType = result.source;

                if (result.source === ResultSource.Stdlib) {
                    // Check which Go source component this belongs to
                    for (const sourcePath of goSourcePaths) {
                        if (filePath.startsWith(sourcePath.path)) {
                            simplifiedPath = filePath.substring(sourcePath.path.length + 1);
                            break;
                        }
                    }
                    resultType = ResultSource.Stdlib;
                } else if (result.source === ResultSource.Dependency) {
                    // Third-party dependency
                    const prefixToRemove = goModCachePath + '/';
                    if (simplifiedPath.startsWith(prefixToRemove)) {
                        simplifiedPath = simplifiedPath.substring(prefixToRemove.length);
                    }
                    resultType = ResultSource.Dependency;
                }

                return {
                    content: result.content,
                    fileName: fileName,
                    lineNumber: lineNumber,
                    filePath: filePath,
                    simplifiedPath: simplifiedPath,
                    source: resultType
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

    // Clear input in webview
    public clearInput() {
        if (this._view) {
            this._view.webview.postMessage({
                command: 'clearInput'
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
            // Use ripgrep to check if Go files exist - much faster than find
            const checkCommand = `rg --files --type go "${workspaceDir}" | head -1`;
            const { stdout: checkResult } = await execPromise(checkCommand);

            if (!checkResult.trim()) {
                console.log('workspace has no Go files:', workspaceDir);
                return results;
            }
        } catch (checkError) {
            console.log('check Go files failed, trying with find as fallback:', checkError);
            // Fallback to find command if ripgrep is not available
            try {
                const checkCommand = `find "${workspaceDir}" -name "*.go" -type f -print -quit`;
                const { stdout: checkResult } = await execPromise(checkCommand);

                if (!checkResult.trim()) {
                    console.log('workspace has no Go files:', workspaceDir);
                    return results;
                }
            } catch (findError) {
                console.log('find fallback also failed:', findError);
                // Continue trying to search, even if check failed
            }
        }

        // Run ripgrep command in workspace directory
        try {
            // Use ripgrep for much faster searching
            // --type go: only search Go files
            // --line-number: include line numbers
            // --with-filename: include filename in output
            // --no-heading: don't group by file
            // --max-count 50: limit results per file to prevent overwhelming output
            const rgCommand = `rg --type go --line-number --with-filename --no-heading --max-count 25 "${searchText}" "${workspaceDir}"`;

            const { stdout } = await execPromise(rgCommand);
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

        } catch (rgError) {
            console.log('ripgrep search failed, trying grep fallback:', rgError);
            // Fallback to grep if ripgrep is not available
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
        }
    } catch (error) {
        console.log('workspace search failed:', error);
    }

    return results;
}

// Search content in dependencies with parallel processing
async function searchInDependencies(workspaceDir: string, searchText: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    try {
        const goModCachePath = await getGoModCachePath();

        // Collect all search targets
        const searchTargets: Array<{ path: string, type: 'stdlib' | 'dependency', name: string }> = [];

        // Add complete Go source paths (stdlib + tools + internal + runtime)
        const goSourcePaths = await getGoSourcePaths();
        for (const sourcePath of goSourcePaths) {
            searchTargets.push({
                path: sourcePath.path,
                type: 'stdlib',
                name: sourcePath.name
            });
        }

        // Add module dependencies
        if (goModCachePath && fs.existsSync(goModCachePath)) {
            const dependencies = await getProjectDependencies(workspaceDir);

            for (const dep of dependencies) {
                const [moduleName, version] = dep.split(' ');
                if (!version) continue;

                const modulePath = path.join(goModCachePath, `${moduleName}@${version}`);
                if (fs.existsSync(modulePath)) {
                    searchTargets.push({
                        path: modulePath,
                        type: 'dependency',
                        name: moduleName
                    });
                }
            }
        }

        // Use all collected search targets; concurrency is controlled by ParallelSearchManager
        const targetsToSearch = searchTargets;

        const startTime = Date.now();
        console.log(`Starting parallel search across ${targetsToSearch.length} targets...`);

        // Execute parallel searches
        const searchPromises = targetsToSearch.map((target, index) =>
            searchManager.execute(async () => {
                const targetStartTime = Date.now();
                const result = await searchSingleTarget(target, searchText);
                const duration = Date.now() - targetStartTime;
                console.log(`Target ${index + 1}/${targetsToSearch.length}: ${target.name} (${result.length} results, ${duration}ms)`);
                return result;
            })
        );

        // Wait for all searches to complete
        const searchResults = await Promise.all(searchPromises);
        const totalDuration = Date.now() - startTime;

        console.log(`Parallel search completed in ${totalDuration}ms. Manager status:`, searchManager.getStatus());

        // Flatten and combine results
        const allResults: SearchResult[] = [];
        for (const targetResults of searchResults) {
            allResults.push(...targetResults);
        }

        // Sort by source type: stdlib first, then dependencies
        const sortedResults = allResults.sort((a, b) => {
            if (a.source === ResultSource.Stdlib && b.source === ResultSource.Dependency) return -1;
            if (a.source === ResultSource.Dependency && b.source === ResultSource.Stdlib) return 1;

            // Within same source type, prioritize non-test files
            const aIsTest = a.location.uri.fsPath.endsWith('_test.go');
            const bIsTest = b.location.uri.fsPath.endsWith('_test.go');
            if (aIsTest && !bIsTest) return 1;
            if (!aIsTest && bIsTest) return -1;

            return 0;
        });

        // Limit total results
        return sortedResults.slice(0, 100);

    } catch (error) {
        console.error('Parallel dependency search failed:', error);
    }

    return results;
}

// Search in a single target (stdlib or dependency module)
async function searchSingleTarget(
    target: { path: string, type: 'stdlib' | 'dependency', name: string },
    searchText: string
): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Get configuration at function scope so it's available in catch block
    const config = vscode.workspace.getConfiguration('golang-search');
    const searchEngine = config.get<string>('searchEngine', 'ripgrep');
    const timeoutMs = config.get<number>('searchTimeout', 30) * 1000; // Convert to milliseconds

    // Declare command variable at function scope so it's available in catch block
    let command: string = '';

    try {

        // Check if target path exists before searching
        if (!fs.existsSync(target.path)) {
            console.log(`Target path does not exist: ${target.path}`);
            return results;
        }

        let maxResults: number;

        // Adjust max results based on target type
        if (target.type === 'stdlib') {
            maxResults = 25; // Increase stdlib results since we simplified the search
        } else {
            maxResults = 10; // Limit per dependency
        }

        // Ensure proper path quoting for command line
        const quotedPath = `"${target.path}"`;
        const quotedSearchText = `"${searchText.replace(/"/g, '\\"')}"`;
        // Determine effective engine based on availability of ripgrep
        const rgAvailable = await getRipgrepAvailability();
        const engineUsed = (searchEngine === 'ripgrep' && !rgAvailable) ? 'grep' : searchEngine;
        if (searchEngine === 'ripgrep' && !rgAvailable) {
            console.log('ripgrep not found, auto-falling back to grep');
        }

        if (engineUsed === 'ripgrep') {
            // Use ripgrep for faster search with fixed-strings to avoid regex issues
            command = `rg --type go --line-number --with-filename --no-heading --fixed-strings --max-count ${maxResults} ${quotedSearchText} ${quotedPath}`;
        } else {
            // Fallback to grep with fixed strings
            command = `grep -rn --fixed-strings ${quotedSearchText} --include="*.go" ${quotedPath} | head -${maxResults}`;
        }

        // Create a promise that rejects after timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Search timeout')), timeoutMs);
        });

        // Race between the command execution and timeout
        const { stdout } = await Promise.race([
            execPromise(command),
            timeoutPromise
        ]);

        if (!stdout.trim()) {
            return results;
        }

        const lines = stdout.split('\n').filter(Boolean);

        for (const line of lines) {
            const match = line.match(/^(.+):(\d+):(.*)/);
            if (match) {
                const [, filePath, lineStr, content] = match;
                const lineNumber = parseInt(lineStr, 10) - 1;
                const uri = vscode.Uri.file(filePath);
                const position = new vscode.Position(lineNumber, 0);
                const range = new vscode.Range(position, position);

                const sourceType = target.type === 'stdlib' ? ResultSource.Stdlib : ResultSource.Dependency;

                const searchResult: SearchResult = {
                    location: new vscode.Location(uri, range),
                    content: content.trim(),
                    source: sourceType
                };

                results.push(searchResult);
            }
        }

        console.log(`Found ${results.length} results in ${target.name}`);

    } catch (error) {
        // Improved error handling and logging
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (errorMessage.includes('timeout') || errorMessage.includes('Search timeout')) {
            console.log(`Search timed out for ${target.name} (${config.get<number>('searchTimeout', 30)}s)`);
        } else {
            // Log detailed error information for debugging
            console.log(`Search failed for ${target.name}:`);
            console.log(`  Command: ${command}`);
            console.log(`  Error: ${errorMessage}`);
            console.log(`  Target path exists: ${fs.existsSync(target.path)}`);

            // Check if it's a command not found error
            if (errorMessage.includes('command not found') || errorMessage.includes('not found')) {
                // Use the actual engine used in this run for messaging
                const engineMessage = command.startsWith('rg') ? 'ripgrep' : 'grep';
                console.log(`  Suggestion: Install ${engineMessage} or switch to grep in settings`);
            }
        }
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

        // Also clear webview input if webview exists
        webviewProvider.clearInput();
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



export function deactivate() { } 