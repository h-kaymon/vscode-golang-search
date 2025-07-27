import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { GoIndexer } from './indexer';
import { getWebviewContent } from './webview';

// Declare console object to resolve type errors
declare var console: {
    log(message?: any, ...optionalParams: any[]): void;
    error(message?: any, ...optionalParams: any[]): void;
    warn(message?: any, ...optionalParams: any[]): void;
    info(message?: any, ...optionalParams: any[]): void;
};

const execPromise = promisify(exec);

// Result source enum
enum ResultSource {
    Workspace = 'workspace',
    Dependency = 'dependency',
    Stdlib = 'stdlib'
}

// Search result interface
interface SearchResult {
    location: vscode.Location;
    content: string;
    source: ResultSource;
}

// Global variables to store search results
let lastSearchResults: SearchResult[] = [];
let lastSearchText: string = '';

// Perform search using indexer and update webview
async function performSearch(indexer: GoIndexer, fuzzy: boolean = false) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = `Search in Go files and dependencies (${fuzzy ? 'Fuzzy' : 'Exact'} mode)`;
    quickPick.title = 'Enter keyword to search';
    quickPick.busy = false;
    quickPick.canSelectMany = false;
    quickPick.matchOnDescription = true;
    quickPick.matchOnDetail = true;
    
    // Debounce function
    let debounceTimeout: NodeJS.Timeout | null = null;
    
    quickPick.onDidChangeValue((value) => {
        if (value.length < 2) {
            quickPick.items = [];
            quickPick.busy = false;
            return;
        }
        
        quickPick.busy = true;
        
        if (debounceTimeout) {
            clearTimeout(debounceTimeout);
        }
        
        debounceTimeout = setTimeout(async () => {
            try {
                console.log(`Starting search for: "${value}" (${fuzzy ? 'fuzzy' : 'exact'})`);
                
                // Check index status
                if (indexer.hasIndex()) {
                    console.log('✅ Index is available - using fast indexed search for all files');
                } else {
                    console.log('❌ No index available - search will be limited');
                }
                
                // Use index for all search (workspace, dependencies, stdlib)
                const allResults = await searchInIndex(value, indexer, fuzzy);
                
                console.log(`Search completed: ${allResults.length} total matches`);
                updateQuickPickItems(quickPick, allResults, value);
    } catch (error) {
                console.error('Search error:', error);
                quickPick.busy = false;
            }
        }, 300); // 300ms debounce
    });
    
    quickPick.onDidChangeSelection(async (selection) => {
        if (selection.length > 0) {
            const selectedItem = selection[0] as any;
            if (selectedItem.location) {
                await openFileAtLocation(selectedItem.location);
                quickPick.dispose();
            }
        }
    });
    
    quickPick.onDidHide(() => {
        quickPick.dispose();
    });
    
    quickPick.show();
}

// Search using index for all files (workspace, dependencies, stdlib)
async function searchInIndex(pattern: string, indexer: GoIndexer, fuzzy: boolean = false): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    try {
        // Check if index is being built
        if (indexer.isIndexBuilding()) {
            console.log('Index is currently being built, search may be limited');
            // Return empty results with a message - the UI should handle this
            return results;
        }
        
        if (!indexer.hasIndex()) {
            console.log('No index available for search');
            return results;
        }
        
        console.log('Searching in index for workspace, dependencies, and stdlib...');
        
        // Search using indexer - returns matches for workspace, dependencies, and stdlib
        const indexResults = await indexer.searchInIndex(pattern, fuzzy);
        
        // Process workspace results
        for (const fileResult of indexResults.workspace) {
            for (const match of fileResult.matches) {
                const uri = vscode.Uri.file(fileResult.filePath);
                const position = new vscode.Position(match.lineNumber, 0);
                const range = new vscode.Range(position, position);
                
                results.push({
                    location: new vscode.Location(uri, range),
                    content: match.lineContent.trim(),
                    source: ResultSource.Workspace
                });
            }
        }
        
        // Process dependency results
        for (const fileResult of indexResults.dependencies) {
            for (const match of fileResult.matches) {
                const uri = vscode.Uri.file(fileResult.filePath);
                const position = new vscode.Position(match.lineNumber, 0);
                            const range = new vscode.Range(position, position);
                            
                results.push({
                    location: new vscode.Location(uri, range),
                    content: match.lineContent.trim(),
                    source: ResultSource.Dependency
                });
            }
        }
        
        // Process stdlib results
        for (const fileResult of indexResults.stdlib) {
            for (const match of fileResult.matches) {
                const uri = vscode.Uri.file(fileResult.filePath);
                const position = new vscode.Position(match.lineNumber, 0);
                const range = new vscode.Range(position, position);
                
                results.push({
                    location: new vscode.Location(uri, range),
                    content: match.lineContent.trim(),
                    source: ResultSource.Stdlib
                });
            }
        }
        
        // Sort results: workspace non-test, dependency non-test, stdlib non-test, then test files
        const workspaceNonTest = results.filter(r => r.source === ResultSource.Workspace && !r.location.uri.fsPath.endsWith('_test.go'));
        const dependencyNonTest = results.filter(r => r.source === ResultSource.Dependency && !r.location.uri.fsPath.endsWith('_test.go'));
        const stdlibNonTest = results.filter(r => r.source === ResultSource.Stdlib && !r.location.uri.fsPath.endsWith('_test.go'));
        const testResults = results.filter(r => r.location.uri.fsPath.endsWith('_test.go'));
        
        const finalResults = [...workspaceNonTest, ...dependencyNonTest, ...stdlibNonTest, ...testResults].slice(0, 100);
        console.log(`Index search completed: ${results.length} total matches, returning ${finalResults.length} results`);
        
        return finalResults;
        
    } catch (error: any) {
        console.error('Index search error:', error);
    }
    
    return results;
}

// Update QuickPick items with search results
function updateQuickPickItems(quickPick: vscode.QuickPick<vscode.QuickPickItem>, results: SearchResult[], searchText: string) {
    // Sort results: non-test files first
    const nonTestResults = results.filter(r => !r.location.uri.fsPath.endsWith('_test.go'));
    const testResults = results.filter(r => r.location.uri.fsPath.endsWith('_test.go'));
    const sortedResults = [...nonTestResults, ...testResults].slice(0, 50);
    
    // Save results for webview
    lastSearchResults = sortedResults;
    lastSearchText = searchText;
    
    // Convert to QuickPickItem format
    const items = sortedResults.map(result => {
        const location = result.location;
        const filePath = location.uri.fsPath;
        const fileName = path.basename(filePath);
        
        const item: vscode.QuickPickItem = {
            label: result.content,
            description: `${fileName}:${location.range.start.line + 1}`,
            detail: filePath,
        };
        
        (item as any).location = location;
        
        if (result.source === ResultSource.Dependency) {
            item.label = `📦 ${result.content}`;
        } else if (result.source === ResultSource.Stdlib) {
            item.label = `⚡ ${result.content}`;
        } else {
            item.label = `🏠 ${result.content}`;
        }
        
        return item;
    });
    
    quickPick.items = items.length > 0 ? items : [{ label: `No results found for "${searchText}"` }];
}

// Open file at specific location
async function openFileAtLocation(location: vscode.Location) {
    try {
        const document = await vscode.workspace.openTextDocument(location.uri);
        const editor = await vscode.window.showTextDocument(document);
        
        const range = location.range;
        editor.selection = new vscode.Selection(range.start, range.start);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    } catch (error) {
        vscode.window.showErrorMessage(`Cannot open file: ${error}`);
    }
}

// Webview provider for search view
class GoSearchWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'golangSearchView';
    private _view?: vscode.WebviewView;
    private _indexer: GoIndexer;

    constructor(_extensionUri: vscode.Uri, indexer: GoIndexer) {
        this._indexer = indexer;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'search':
                    await this._performSearch(data.value, data.fuzzy || false);
                    break;
                case 'openFile':
                    const uri = vscode.Uri.file(data.uri);
                    const position = new vscode.Position(data.line, 0);
                    const location = new vscode.Location(uri, position);
                    await openFileAtLocation(location);
                    break;
            }
        });
    }

    public focus() {
        if (this._view) {
            this._view.show?.(true);
        }
    }

    private async _performSearch(searchText: string, fuzzy: boolean = false) {
        if (!this._view || searchText.length < 2) {
            return;
        }
        
        this._view.webview.postMessage({ type: 'searchStart' });
        
        try {
            // Check if index is being built
            if (this._indexer.isIndexBuilding()) {
                this._view.webview.postMessage({ 
                    type: 'searchInfo',
                    message: 'Index is being built in background. Search will be limited until indexing completes.',
                    status: 'building'
                });
                return;
            }
            
            const results = await searchInIndex(searchText, this._indexer, fuzzy);
            
            // If no results and no index, provide helpful message
            if (results.length === 0 && !this._indexer.hasIndex()) {
                this._view.webview.postMessage({ 
                    type: 'searchInfo',
                    message: 'No search index available. The index may still be building in the background.',
                    status: 'no-index'
                });
                return;
            }
            
            this._view.webview.postMessage({ 
                type: 'searchResults',
                results: results.map(r => ({
                    content: r.content,
                    uri: r.location.uri.fsPath,
                    line: r.location.range.start.line,
                    isDependency: r.source === ResultSource.Dependency,
                    isStdlib: r.source === ResultSource.Stdlib,
                    isTest: r.location.uri.fsPath.endsWith('_test.go')
                })),
                searchText: searchText,
                fuzzy: fuzzy,
                indexStatus: this._indexer.getIndexStatus()
            });
        } catch (error) {
            this._view.webview.postMessage({ 
                type: 'searchError',
                error: error instanceof Error ? error.message : String(error)
            });
        }
    }
    
    private _getHtmlForWebview(webview: vscode.Webview) {
        return getWebviewContent();
    }
}

// Extension activation
export async function activate(context: vscode.ExtensionContext) {
    // Set up activation timeout protection
    const activationTimeout = setTimeout(() => {
        console.error('Extension activation is taking too long (>5s), this might indicate a problem');
        vscode.window.showWarningMessage('Go Search extension is taking longer than expected to activate. Check the Output panel for details.');
    }, 5000);
    
    try {
        console.log('Go Search extension is now activating...');
        const startTime = Date.now();

        // Create status bar item for index status
        const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'golang-search.rebuildIndex';
        context.subscriptions.push(statusBarItem);
        
        // Show initial status
        statusBarItem.text = '$(search) Go Index';
        statusBarItem.tooltip = 'Go Search: Checking index...';
        statusBarItem.show();

        // Initialize indexer with error handling
        let indexer: GoIndexer;
        try {
            console.log('Creating GoIndexer...');
            indexer = new GoIndexer(context);
            console.log('GoIndexer created successfully');
        } catch (indexerError) {
            console.error('Failed to create GoIndexer:', indexerError);
            statusBarItem.text = '$(warning) Go Index';
            statusBarItem.tooltip = 'Go Search: Initialization failed. Click to retry.';
            
            // Create a minimal fallback indexer
            indexer = new GoIndexer(context);
        }

        // Register the webview provider
        let golangSearchView: GoSearchWebviewProvider;
        try {
            console.log('Creating webview provider...');
            golangSearchView = new GoSearchWebviewProvider(context.extensionUri, indexer);
            context.subscriptions.push(
                vscode.window.registerWebviewViewProvider(GoSearchWebviewProvider.viewType, golangSearchView)
            );
            console.log('Webview provider registered successfully');
        } catch (webviewError) {
            console.error('Failed to create webview provider:', webviewError);
            statusBarItem.text = '$(warning) Go Index';
            statusBarItem.tooltip = 'Go Search: Webview initialization failed.';
            throw webviewError; // This is critical, so we need to fail
        }

        // Register commands with error handling
        try {
            console.log('Registering commands...');
            
            context.subscriptions.push(
                vscode.commands.registerCommand('golang-search.search', () => {
                    try {
                        performSearch(indexer);
                    } catch (error) {
                        console.error('Error in search command:', error);
                        vscode.window.showErrorMessage(`Search failed: ${error}`);
                    }
                })
            );

            context.subscriptions.push(
                vscode.commands.registerCommand('golang-search.searchFuzzy', () => {
                    try {
                        performSearch(indexer, true);
                    } catch (error) {
                        console.error('Error in fuzzy search command:', error);
                        vscode.window.showErrorMessage(`Fuzzy search failed: ${error}`);
                    }
                })
            );

            context.subscriptions.push(
                vscode.commands.registerCommand('golang-search.searchInView', () => {
                    try {
                        golangSearchView.focus();
                    } catch (error) {
                        console.error('Error focusing search view:', error);
                        vscode.window.showErrorMessage(`Failed to open search view: ${error}`);
                    }
                })
            );

            context.subscriptions.push(
                vscode.commands.registerCommand('golang-search.rebuildIndex', async () => {
                    try {
                        statusBarItem.text = '$(loading~spin) Building Index...';
                        statusBarItem.tooltip = 'Go Search: Building index...';
                        
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: 'Rebuilding Go Search Index',
                            cancellable: false
                        }, async (progress, token) => {
                            await indexer.buildIndex(progress);
                        });
                        
                        vscode.window.showInformationMessage('Go search index rebuilt successfully!');
                        
                        statusBarItem.text = '$(search) Go Index';
                        statusBarItem.tooltip = 'Go Search: Index ready';
                        
                        // Focus the search view after rebuilding
                        setTimeout(() => {
                            golangSearchView.focus();
                        }, 100);
                    } catch (error) {
                        console.error('Error rebuilding index:', error);
                        statusBarItem.text = '$(warning) Go Index';
                        statusBarItem.tooltip = 'Go Search: Rebuild failed. Click to retry.';
                        vscode.window.showErrorMessage(`Failed to rebuild index: ${error}`);
                    }
                })
            );

            context.subscriptions.push(
                vscode.commands.registerCommand('golang-search.showWorkspaceIndexes', async () => {
                    try {
                        const indexes = await GoIndexer.listWorkspaceIndexes(context.globalStorageUri.fsPath);
                        
                        if (indexes.length === 0) {
                            vscode.window.showInformationMessage('No workspace indexes found.');
                            return;
                        }
                        
                        const items = indexes.map(index => ({
                            label: index.workspaceName,
                            description: `Last updated ${index.lastUpdated.toLocaleString()}, Size: ${(index.size / 1024).toFixed(1)}KB`,
                            detail: index.indexPath,
                            indexPath: index.indexPath
                        }));
                        
                        const selected = await vscode.window.showQuickPick(items, {
                            placeHolder: 'Select a workspace index to manage'
                        });
                        
                        if (selected) {
                            const action = await vscode.window.showQuickPick([
                                'Delete Index',
                                'Show Location',
                                'Show Info'
                            ], {
                                placeHolder: `Manage index for ${selected.label}`
                            });
                            
                            if (action === 'Delete Index') {
                                try {
                                    fs.unlinkSync(selected.indexPath);
                                    vscode.window.showInformationMessage(`Index for ${selected.label} deleted.`);
                                } catch (error) {
                                    vscode.window.showErrorMessage(`Failed to delete index: ${error}`);
                                }
                            } else if (action === 'Show Location') {
                                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path.dirname(selected.indexPath)));
                            } else if (action === 'Show Info') {
                                vscode.window.showInformationMessage(`Workspace: ${selected.label}
Files: ${selected.description}
Path: ${selected.detail}`);
                            }
                        }
                    } catch (error) {
                        console.error('Error showing workspace indexes:', error);
                        vscode.window.showErrorMessage(`Failed to show workspace indexes: ${error}`);
                    }
                })
            );

            context.subscriptions.push(
                vscode.commands.registerCommand('golang-search.cleanupIndexes', async () => {
                    try {
                        const result = await vscode.window.showWarningMessage(
                            'This will delete ALL index files for the current workspace and force a complete rebuild. Continue?',
                            { modal: true },
                            'Yes, Clean Up',
                            'Cancel'
                        );
                        
                        if (result !== 'Yes, Clean Up') {
                            return;
                        }
                        
                        statusBarItem.text = '$(loading~spin) Cleaning Indexes...';
                        statusBarItem.tooltip = 'Go Search: Cleaning up index files...';
                        
                        // Clean up all index files for current workspace
                        const indexer = new GoIndexer(context);
                        const storageDir = indexer.getStorageDirectory();
                        const paths = indexer.getIndexFilePaths(storageDir);
                        let cleanedFiles = 0;
                        
                        // Clean up split format files
                        for (const [name, filePath] of Object.entries(paths)) {
                            if (name !== 'legacy' && fs.existsSync(filePath)) {
                                try {
                                    fs.unlinkSync(filePath);
                                    cleanedFiles++;
                                    console.log(`Cleaned up ${name} index file: ${filePath}`);
                                } catch (error) {
                                    console.error(`Failed to clean ${name} file:`, error);
                                }
                            }
                            
                            // Also clean up associated multi-file parts
                            const baseNameWithoutExt = path.basename(filePath, '.json');
                            const dirPath = path.dirname(filePath);
                            
                            try {
                                const files = fs.readdirSync(dirPath);
                                const relatedFiles = files.filter(file => 
                                    file.startsWith(baseNameWithoutExt) && 
                                    (file.includes('-part') || file.includes('-meta'))
                                );
                                
                                for (const relatedFile of relatedFiles) {
                                    const relatedPath = path.join(dirPath, relatedFile);
                                    try {
                                        fs.unlinkSync(relatedPath);
                                        cleanedFiles++;
                                        console.log(`Cleaned up related file: ${relatedPath}`);
                                    } catch (relatedError) {
                                        console.error(`Failed to clean related file: ${relatedPath}`, relatedError);
                                    }
                                }
                            } catch (dirError) {
                                console.log(`Could not scan directory for related files: ${dirPath}`);
                            }
                        }
                        
                        // Clean up legacy file
                        if (fs.existsSync(paths.legacy)) {
                            try {
                                fs.unlinkSync(paths.legacy);
                                cleanedFiles++;
                                console.log(`Cleaned up legacy index file: ${paths.legacy}`);
                            } catch (error) {
                                console.error('Failed to clean legacy file:', error);
                            }
                        }
                        
                        statusBarItem.text = '$(search) Go Index';
                        statusBarItem.tooltip = 'Go Search: Index cleaned, ready for rebuild';
                        
                        vscode.window.showInformationMessage(
                            `Cleaned up ${cleanedFiles} index file(s). Run "Rebuild Index" to create fresh indexes.`,
                            'Rebuild Now'
                        ).then(selection => {
                            if (selection === 'Rebuild Now') {
                                vscode.commands.executeCommand('golang-search.rebuildIndex');
                            }
                        });
                        
                    } catch (error) {
                        console.error('Error cleaning up indexes:', error);
                        statusBarItem.text = '$(warning) Go Index';
                        statusBarItem.tooltip = 'Go Search: Cleanup failed. Click to rebuild.';
                        vscode.window.showErrorMessage(`Failed to cleanup indexes: ${error}`);
                    }
                })
            );
            
            console.log('Commands registered successfully');
        } catch (commandError) {
            console.error('Failed to register commands:', commandError);
            statusBarItem.text = '$(warning) Go Index';
            statusBarItem.tooltip = 'Go Search: Command registration failed.';
        }

        // Asynchronously load or build index in the background (don't await)
        console.log('Starting background index loading...');
        setTimeout(() => {
            loadIndexInBackground(indexer, statusBarItem, golangSearchView)
                .catch(error => {
                    console.error('Background index loading failed:', error);
                    statusBarItem.text = '$(warning) Go Index';
                    statusBarItem.tooltip = 'Go Search: Background loading failed. Click to rebuild.';
                });
        }, 500); // Delay to ensure activation completes first

        const activationTime = Date.now() - startTime;
        console.log(`Go Search extension is now active! (Activation took ${activationTime}ms)`);
        
    } catch (error) {
        console.error('Critical activation error:', error);
        vscode.window.showErrorMessage(`Go Search extension failed to activate: ${error}`);
        throw error; // Re-throw critical errors
    } finally {
        clearTimeout(activationTimeout);
    }
}

// Background index loading function
async function loadIndexInBackground(
    indexer: GoIndexer, 
    statusBarItem: vscode.StatusBarItem, 
    golangSearchView: GoSearchWebviewProvider
) {
    try {
        // Check if we have any Go-related files in workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            statusBarItem.text = '$(search) Go Index';
            statusBarItem.tooltip = 'Go Search: No workspace';
            return;
        }

        // Check for Go files in workspace
        let hasGoFiles = false;
        for (const folder of workspaceFolders) {
            try {
                const { stdout } = await execPromise(`find "${folder.uri.fsPath}" -maxdepth 3 \\( -name "*.go" -o -name "go.mod" \\) -type f | head -1`);
                if (stdout.trim()) {
                    hasGoFiles = true;
                    break;
                }
            } catch (error) {
                // Ignore errors
            }
        }

        if (!hasGoFiles) {
            statusBarItem.text = '$(search) Go Index';
            statusBarItem.tooltip = 'Go Search: No Go files found';
            return;
        }

        statusBarItem.text = '$(loading~spin) Loading Index...';
        statusBarItem.tooltip = 'Go Search: Loading index...';

        // Try to load existing index
        const hasIndex = await indexer.loadIndex();
        
        if (hasIndex) {
            console.log('Loaded existing index in background');
            statusBarItem.text = '$(search) Go Index';
            statusBarItem.tooltip = 'Go Search: Index ready';
        } else {
            console.log('No valid index found, building new index in background...');
            statusBarItem.text = '$(loading~spin) Building Index...';
            statusBarItem.tooltip = 'Go Search: Building index...';
            
            // Build index without user notification (silent background build)
            await indexer.buildIndex();
            
            console.log('Background index build completed');
            statusBarItem.text = '$(search) Go Index';
            statusBarItem.tooltip = 'Go Search: Index ready';
            
            // Show a subtle notification that index is ready
            vscode.window.showInformationMessage('Go search index is ready!', 'Open Search').then(selection => {
                if (selection === 'Open Search') {
                    golangSearchView.focus();
                }
            });
        }
    } catch (error) {
        console.error('Background index loading failed:', error);
        
        // If it's a string length error, force complete cleanup and rebuild
        if (error && typeof error === 'object' && 'message' in error && 
            typeof (error as any).message === 'string' && 
            (error as any).message.includes('Invalid string length')) {
            
            console.log('Detected "Invalid string length" error, performing emergency cleanup...');
            statusBarItem.text = '$(loading~spin) Emergency Cleanup...';
            statusBarItem.tooltip = 'Go Search: Cleaning up corrupted index files...';
            
            try {
                // Force cleanup all index files
                const storageDir = indexer.getStorageDirectory();
                const paths = indexer.getIndexFilePaths(storageDir);
                let cleanedFiles = 0;
                
                // Remove all index files (both split and legacy formats)
                const allPaths = Object.values(paths);
                for (const filePath of allPaths) {
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                            cleanedFiles++;
                            console.log(`Emergency cleanup removed: ${filePath}`);
                        } catch (deleteError) {
                            console.error(`Failed to remove during emergency cleanup: ${filePath}`, deleteError);
                        }
                    }
                    
                    // Also clean up associated multi-file parts during emergency cleanup
                    const baseNameWithoutExt = path.basename(filePath, '.json');
                    const dirPath = path.dirname(filePath);
                    
                    try {
                        const files = fs.readdirSync(dirPath);
                        const relatedFiles = files.filter(file => 
                            file.startsWith(baseNameWithoutExt) && 
                            (file.includes('-part') || file.includes('-meta'))
                        );
                        
                        for (const relatedFile of relatedFiles) {
                            const relatedPath = path.join(dirPath, relatedFile);
                            try {
                                fs.unlinkSync(relatedPath);
                                cleanedFiles++;
                                console.log(`Emergency cleanup removed related file: ${relatedPath}`);
                            } catch (relatedError) {
                                console.error(`Failed to remove related file during emergency cleanup: ${relatedPath}`, relatedError);
                            }
                        }
                    } catch (dirError) {
                        console.log(`Could not scan directory during emergency cleanup: ${dirPath}`);
                    }
                }
                
                console.log(`Emergency cleanup completed: ${cleanedFiles} files removed`);
                
                // Try to rebuild index after cleanup
                statusBarItem.text = '$(loading~spin) Building Fresh Index...';
                statusBarItem.tooltip = 'Go Search: Building fresh index after cleanup...';
                
                await indexer.buildIndex();
                
                statusBarItem.text = '$(search) Go Index';
                statusBarItem.tooltip = 'Go Search: Index rebuilt successfully';
                
                vscode.window.showInformationMessage(
                    'Detected and fixed index corruption. Fresh index built successfully!', 
                    'Open Search'
                ).then(selection => {
                    if (selection === 'Open Search') {
                        golangSearchView.focus();
                    }
                });
                
            } catch (cleanupError) {
                console.error('Emergency cleanup failed:', cleanupError);
                statusBarItem.text = '$(error) Go Index';
                statusBarItem.tooltip = 'Go Search: Emergency cleanup failed. Use "Clean Up Index Files" command.';
                
                vscode.window.showErrorMessage(
                    'Go Search encountered index corruption. Please run "Go Search: Clean Up Index Files" command.',
                    'Clean Up Now'
                ).then(selection => {
                    if (selection === 'Clean Up Now') {
                        vscode.commands.executeCommand('golang-search.cleanupIndexes');
                    }
                });
            }
        } else {
            // Handle other types of errors
            statusBarItem.text = '$(warning) Go Index';
            statusBarItem.tooltip = 'Go Search: Background loading failed. Click to rebuild.';
        }
    }
}

export function deactivate() {} 