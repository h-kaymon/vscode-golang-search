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
async function performSearch(indexer: GoIndexer) {
    const quickPick = vscode.window.createQuickPick();
    quickPick.placeholder = 'Search in Go files and dependencies';
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
                console.log(`Starting search for: "${value}"`);
                
                // Check index status
                if (indexer.hasIndex()) {
                    console.log('✅ Index is available - using fast indexed search for all files');
                } else {
                    console.log('❌ No index available - search will be limited');
                }
                
                // Use index for all search (workspace, dependencies, stdlib)
                const allResults = await searchInIndex(value, indexer);
                
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
async function searchInIndex(pattern: string, indexer: GoIndexer): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    try {
        if (!indexer.hasIndex()) {
            console.log('No index available for search');
            return results;
        }
        
        console.log('Searching in index for workspace, dependencies, and stdlib...');
        
        // Search using indexer - returns matches for workspace, dependencies, and stdlib
        const indexResults = await indexer.searchInIndex(pattern);
        
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
                    await this._performSearch(data.value);
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

    private async _performSearch(searchText: string) {
        if (!this._view || searchText.length < 2) {
            return;
        }
        
        this._view.webview.postMessage({ type: 'searchStart' });
        
        try {
            const results = await searchInIndex(searchText, this._indexer);
            
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
                searchText: searchText
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
    console.log('Go Search extension is now activating...');

    // Initialize indexer
    const indexer = new GoIndexer(context);

    // Register the webview provider
    const golangSearchView = new GoSearchWebviewProvider(context.extensionUri, indexer);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(GoSearchWebviewProvider.viewType, golangSearchView)
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('golang-search.search', () => {
            performSearch(indexer);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('golang-search.searchInView', () => {
            golangSearchView.focus();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('golang-search.rebuildIndex', async () => {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Rebuilding Go Search Index',
                cancellable: false
            }, async (progress, token) => {
                await indexer.buildIndex(progress);
            });
            
            vscode.window.showInformationMessage('Go search index rebuilt successfully!');
            
            // Focus the search view after rebuilding
            setTimeout(() => {
                golangSearchView.focus();
            }, 100);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('golang-search.showWorkspaceIndexes', async () => {
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
        })
    );

    // Load or build index
    console.log('Loading or building index...');
    const hasIndex = await indexer.loadIndex();
    if (!hasIndex) {
        console.log('No valid index found, building new index...');
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Building Go Search Index',
            cancellable: false
        }, async (progress, token) => {
            await indexer.buildIndex(progress);
        });
        
        vscode.window.showInformationMessage('Go search index built successfully!');
        
        // Focus the search view after initial build
        setTimeout(() => {
            golangSearchView.focus();
        }, 100);
    } else {
        console.log('Loaded existing index');
    }

    console.log('Go Search extension is now active!');
}

export function deactivate() {}