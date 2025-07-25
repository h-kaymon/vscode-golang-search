import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execPromise = promisify(exec);

interface FileIndex {
    path: string;
    lastModified: number;
    symbols: string[];
    content: string; // Original content for display
    searchContent: string; // Lowercase content for fast searching
}

interface Index {
    version: string;
    lastUpdated: number;
    workspacePath: string;
    goModHash: string; // go.mod file hash to detect changes
    goVersion: string; // Go version to detect Go installation changes
    workspace: Map<string, FileIndex>; // Workspace Go files
    dependencies: Map<string, FileIndex>; // Only dependencies, no workspace files
    stdlib: Map<string, FileIndex>; // Go standard library
}

export class GoIndexer {
    private indexPath: string;
    private index: Index;
    private goModWatcher: vscode.FileSystemWatcher | undefined;
    private updateTimeout: NodeJS.Timeout | undefined;
    private periodicCheckInterval: NodeJS.Timeout | undefined;
    private currentWorkspace: string;
    
    constructor(context: vscode.ExtensionContext) {
        this.currentWorkspace = this.getCurrentWorkspaceId();
        this.indexPath = this.getIndexPath(context.globalStorageUri.fsPath);
        
        this.index = {
            version: '2.1', // Bumped version for new format
            lastUpdated: 0,
            workspacePath: this.currentWorkspace,
            goModHash: '',
            goVersion: '',
            workspace: new Map(),
            dependencies: new Map(),
            stdlib: new Map()
        };
        
        // Ensure storage directory exists
        if (!fs.existsSync(context.globalStorageUri.fsPath)) {
            fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
        }
        
        // Watch for dependency changes only
        this.setupFileWatchers();
        
        // Setup periodic index freshness check (every 6 hours)
        this.setupPeriodicCheck(context);
    }
    
    private hashString(str: string): string {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return Math.abs(hash).toString(16);
    }
    
    private async getGoModHash(): Promise<string> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return '';
        }
        
        // Combine hashes from all workspace folders
        const hashes: string[] = [];
        
        for (const workspaceFolder of workspaceFolders) {
            const goModPath = path.join(workspaceFolder.uri.fsPath, 'go.mod');
            if (fs.existsSync(goModPath)) {
                try {
                    const content = fs.readFileSync(goModPath, 'utf8');
                    hashes.push(this.hashString(content));
                } catch (error) {
                    // Ignore errors for individual files
                }
            }
        }
        
        // Return combined hash
        return this.hashString(hashes.join('::'));
    }
    
    private async getGoVersion(): Promise<string> {
        try {
            const { stdout } = await execPromise('go version');
            return stdout.trim();
        } catch (error) {
            return '';
        }
    }
    
    private getCurrentWorkspaceId(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return 'no-workspace';
        }
        
        // Support multiple workspace folders
        if (workspaceFolders.length === 1) {
            return workspaceFolders[0].uri.fsPath;
        }
        
        // For multi-root workspaces, create a combined identifier
        const paths = workspaceFolders.map(folder => folder.uri.fsPath).sort();
        return paths.join('::');
    }
    
    private getIndexPath(storageDir: string): string {
        const workspaceHash = this.hashString(this.currentWorkspace);
        const indexFileName = `go-search-index-${workspaceHash}.json`;
        return path.join(storageDir, indexFileName);
    }
    
    private getWorkspaceDisplayName(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return 'No Workspace';
        }
        
        if (workspaceFolders.length === 1) {
            return path.basename(workspaceFolders[0].uri.fsPath);
        }
        
        return `Multi-root (${workspaceFolders.length} folders)`;
    }
    
    // Check if current workspace has changed
    private hasWorkspaceChanged(): boolean {
        const currentId = this.getCurrentWorkspaceId();
        return currentId !== this.currentWorkspace;
    }
    
    private setupFileWatchers() {
        // Setup watcher for go.mod/go.sum file changes
        this.setupGoModWatcher();
        
        // Setup watcher for workspace Go file changes
        this.setupWorkspaceFileWatcher();
    }
    
    private setupGoModWatcher() {
        if (this.goModWatcher) {
            this.goModWatcher.dispose();
        }
        
        // Watch go.mod and go.sum files in all workspace folders
        this.goModWatcher = vscode.workspace.createFileSystemWatcher('**/go.{mod,sum}');
        
        const scheduleDependencyUpdate = () => {
            if (this.updateTimeout) {
                clearTimeout(this.updateTimeout);
            }
            this.updateTimeout = setTimeout(() => {
                this.updateDependencyIndex();
            }, 3000); // 3 second debounce
        };
        
        this.goModWatcher.onDidChange(scheduleDependencyUpdate);
        this.goModWatcher.onDidCreate(scheduleDependencyUpdate);
        this.goModWatcher.onDidDelete(scheduleDependencyUpdate);
        
        // When workspace folders change, switch workspace
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await this.switchWorkspace();
        });
    }
    
    private workspaceFileWatcher?: vscode.FileSystemWatcher;
    private workspaceUpdateTimeout?: NodeJS.Timeout;
    
    private setupWorkspaceFileWatcher() {
        if (this.workspaceFileWatcher) {
            this.workspaceFileWatcher.dispose();
        }
        
        // Watch Go files in workspace
        this.workspaceFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.go');
        
        const scheduleWorkspaceUpdate = (uri: vscode.Uri) => {
            if (this.workspaceUpdateTimeout) {
                clearTimeout(this.workspaceUpdateTimeout);
            }
            this.workspaceUpdateTimeout = setTimeout(() => {
                this.updateWorkspaceFile(uri.fsPath);
            }, 1000); // 1 second debounce for workspace files
        };
        
        this.workspaceFileWatcher.onDidChange((uri) => {
            scheduleWorkspaceUpdate(uri);
        });
        
        this.workspaceFileWatcher.onDidCreate((uri) => {
            scheduleWorkspaceUpdate(uri);
        });
        
        this.workspaceFileWatcher.onDidDelete((uri) => {
            // Remove from index immediately
            this.index.workspace.delete(uri.fsPath);
            this.saveIndex();
        });
    }
    
    // Update a single workspace file in the index
    private async updateWorkspaceFile(filePath: string) {
        try {
            console.log(`Updating workspace file in index: ${filePath}`);
            await this.indexFile(filePath, 'workspace');
            await this.saveIndex();
        } catch (error) {
            console.error(`Failed to update workspace file ${filePath}:`, error);
        }
    }
    
    // Switch to a different workspace index
    private async switchWorkspace() {
        // Update current workspace
        this.currentWorkspace = this.getCurrentWorkspaceId();
        
        // Get storage directory from current indexPath
        const storageDir = path.dirname(this.indexPath);
        this.indexPath = this.getIndexPath(storageDir);
        
        // Reset index
        this.index = {
            version: '2.1',
            lastUpdated: 0,
            workspacePath: this.currentWorkspace,
            goModHash: '',
            goVersion: '',
            workspace: new Map(),
            dependencies: new Map(),
            stdlib: new Map()
        };
        
        // Try to load existing index for this workspace
        const hasIndex = await this.loadIndex();
        if (!hasIndex) {
            console.log(`No index found for workspace ${this.getWorkspaceDisplayName()}, building new index...`);
            await this.buildIndex();
        } else {
            console.log(`Loaded existing index for workspace ${this.getWorkspaceDisplayName()}`);
        }
    }
    
    private setupPeriodicCheck(context: vscode.ExtensionContext) {
        // Check index freshness every 6 hours
        this.periodicCheckInterval = setInterval(async () => {
            const sixHoursInMs = 6 * 60 * 60 * 1000;
            if (this.index.lastUpdated > 0 && Date.now() - this.index.lastUpdated > sixHoursInMs) {
                console.log('Periodic check: Index is outdated, suggesting rebuild...');
                
                const currentGoModHash = await this.getGoModHash();
                const currentGoVersion = await this.getGoVersion();
                
                if (currentGoModHash !== this.index.goModHash || currentGoVersion !== this.index.goVersion) {
                    vscode.window.showInformationMessage(
                        'Go dependencies or Go version may have changed. Update search index?',
                        'Update Now'
                    ).then(selection => {
                        if (selection === 'Update Now') {
                            vscode.commands.executeCommand('golang-search.rebuildIndex');
                        }
                    });
                }
            }
        }, 60 * 60 * 1000); // Check every hour
        
        // Add to context subscriptions for cleanup
        context.subscriptions.push({
            dispose: () => {
                if (this.periodicCheckInterval) {
                    clearInterval(this.periodicCheckInterval);
                }
            }
        });
    }
    
    async loadIndex(): Promise<boolean> {
        try {
            if (fs.existsSync(this.indexPath)) {
                const data = fs.readFileSync(this.indexPath, 'utf8');
                const jsonIndex = JSON.parse(data);
                
                // Convert maps from JSON
                this.index = {
                    version: jsonIndex.version || '1.0',
                    lastUpdated: jsonIndex.lastUpdated,
                    workspacePath: jsonIndex.workspacePath,
                    goModHash: jsonIndex.goModHash || '',
                    goVersion: jsonIndex.goVersion || '',
                    workspace: new Map(jsonIndex.workspace),
                    dependencies: new Map(jsonIndex.dependencies),
                    stdlib: new Map(jsonIndex.stdlib)
                };
                
                // Check if this is for the current workspace
                const currentWorkspace = await this.getCurrentWorkspaceId();
                if (this.index.workspacePath !== currentWorkspace) {
                    console.log('Index is for different workspace, rebuilding...');
                    return false;
                }
                
                // Check version compatibility - force rebuild for older versions
                if (this.index.version !== '2.1') {
                    console.log('Index version outdated (need 2.1 for searchContent support), rebuilding...');
                    return false;
                }
                
                // Validate that loaded FileIndex objects have searchContent field
                const sampleDep = this.index.dependencies.entries().next().value;
                if (sampleDep && !sampleDep[1].searchContent) {
                    console.log('Index missing searchContent field, rebuilding...');
                    return false;
                }
                
                // Check if go.mod has changed
                const currentGoModHash = await this.getGoModHash();
                if (currentGoModHash !== this.index.goModHash) {
                    console.log('go.mod has changed, rebuilding index...');
                    return false;
                }
                
                // Check if Go version has changed
                const currentGoVersion = await this.getGoVersion();
                if (currentGoVersion !== this.index.goVersion) {
                    console.log('Go version has changed, rebuilding index...');
                    return false;
                }
                
                return true;
            }
        } catch (error) {
            console.error('Failed to load index:', error);
        }
        
        return false;
    }
    
    async buildIndex(progress?: vscode.Progress<{
        message?: string;
        increment?: number;
    }>) {
        const workspaceDisplayName = this.getWorkspaceDisplayName();
        progress?.report({ message: `Building Go index for ${workspaceDisplayName}...` });
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log('No workspace folders available for indexing');
            return;
        }
        
        // Clear existing index
        this.index.workspace.clear();
        this.index.dependencies.clear();
        this.index.stdlib.clear();
        
        // Update workspace info
        this.index.workspacePath = this.currentWorkspace;
        this.index.goModHash = await this.getGoModHash();
        this.index.goVersion = await this.getGoVersion();
        
        // Index workspace files
        progress?.report({ message: 'Indexing workspace files...', increment: 20 });
        await this.indexWorkspaceFiles();
        
        // Index Go standard library
        progress?.report({ message: 'Indexing Go standard library...', increment: 40 });
        await this.indexGoStdlib();
        
        // Index dependencies from all workspace folders
        progress?.report({ message: 'Indexing Go dependencies...', increment: 60 });
        await this.indexDependencies();
        
        // Save index
        progress?.report({ message: 'Saving index...', increment: 80 });
        await this.saveIndex();
        
        progress?.report({ message: `Index built successfully for ${workspaceDisplayName}`, increment: 100 });
        console.log(`Index built for workspace: ${workspaceDisplayName} (${this.index.dependencies.size} deps, ${this.index.stdlib.size} stdlib files)`);
    }
    
    private async indexWorkspaceFiles() {
        try {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                console.log('No workspace folders available for indexing workspace files');
                return;
            }

            for (const folder of workspaceFolders) {
                const workspacePath = folder.uri.fsPath;
                const { stdout } = await execPromise(`find "${workspacePath}" -maxdepth 10 -name "*.go" -type f | head -20000`, {
                    maxBuffer: 1024 * 1024 * 100
                });

                const files = stdout.trim().split('\n').filter(Boolean);
                for (const file of files) {
                    await this.indexFile(file, 'workspace');
                }
            }
            console.log(`Indexed ${this.index.workspace.size} workspace files`);
        } catch (error) {
            console.error('Failed to index workspace files:', error);
        }
    }

    private async indexGoStdlib() {
        try {
            // Get Go installation path
            const { stdout: goroot } = await execPromise('go env GOROOT');
            const gorootPath = goroot.trim();
            const stdlibPath = path.join(gorootPath, 'src');
            
            if (!fs.existsSync(stdlibPath)) {
                console.log('Go standard library source not found');
                return;
            }
            
            // Find all Go files in stdlib (limit depth to avoid too many files)
            const { stdout } = await execPromise(`find "${stdlibPath}" -maxdepth 8 -name "*.go" -type f | head -10000`, {
                maxBuffer: 1024 * 1024 * 100
            });
            
            const files = stdout.trim().split('\n').filter(Boolean);
            
            // Process files in parallel batches
            const batchSize = 100;
            for (let i = 0; i < files.length; i += batchSize) {
                const batch = files.slice(i, i + batchSize);
                await Promise.all(batch.map(file => this.indexFile(file, 'stdlib')));
            }
            
            console.log(`Indexed ${files.length} Go standard library files`);
        } catch (error) {
            console.error('Failed to index Go standard library:', error);
        }
    }
    
    private async indexDependencies() {
        try {
            const dependencyPaths = await this.getWorkspaceDependencyPaths();
            if (dependencyPaths.length === 0) {
                console.log('No dependency paths found');
                return;
            }
            
            let totalFiles = 0;
            
            for (const depPath of dependencyPaths) {
                // Find all Go files in this dependency path (limit to avoid too many files)
                const { stdout } = await execPromise(`find "${depPath}" -maxdepth 10 -name "*.go" -type f | head -20000`, {
                    maxBuffer: 1024 * 1024 * 100
                });
                
                const files = stdout.trim().split('\n').filter(Boolean);
                totalFiles += files.length;
                
                // Process files in parallel batches
                const batchSize = 100;
                for (let i = 0; i < files.length; i += batchSize) {
                    const batch = files.slice(i, i + batchSize);
                    await Promise.all(batch.map(file => this.indexFile(file, 'dependency')));
                }
            }
            
            console.log(`Indexed ${totalFiles} dependency files from ${dependencyPaths.length} paths`);
        } catch (error) {
            console.error('Failed to index dependencies:', error);
        }
    }
    
    // Get workspace-specific dependency paths
    private async getWorkspaceDependencyPaths(): Promise<string[]> {
        const dependencyPaths: Set<string> = new Set();
        
        try {
            // Get GOPATH and GOMODCACHE
            const { stdout: gopath } = await execPromise('go env GOPATH');
            const { stdout: gomodcache } = await execPromise('go env GOMODCACHE');
            const gomodPath = gomodcache.trim() || path.join(gopath.trim(), 'pkg', 'mod');
            
            if (!fs.existsSync(gomodPath)) {
                console.log('Go module cache not found');
                return [];
            }
            
            dependencyPaths.add(gomodPath);
            
            // Also check workspace-specific vendor directories
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                for (const folder of workspaceFolders) {
                    const vendorPath = path.join(folder.uri.fsPath, 'vendor');
                    if (fs.existsSync(vendorPath)) {
                        dependencyPaths.add(vendorPath);
                    }
                }
            }
        } catch (error) {
            console.error('Failed to get dependency paths:', error);
        }
        
        return Array.from(dependencyPaths);
    }
    
    private async indexFile(filePath: string, type: 'dependency' | 'stdlib' | 'workspace') {
        try {
            const stats = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf8');
            
            // Extract symbols (function names, type names, etc.)
            const symbols: string[] = [];
            
            // Match function declarations
            const funcRegex = /func\s+(\w+)\s*\(/g;
            let match;
            while ((match = funcRegex.exec(content)) !== null) {
                symbols.push(match[1]);
            }
            
            // Match type declarations
            const typeRegex = /type\s+(\w+)\s+/g;
            while ((match = typeRegex.exec(content)) !== null) {
                symbols.push(match[1]);
            }
            
            // Match const and var declarations
            const declRegex = /(?:const|var)\s+(\w+)\s*[=:]/g;
            while ((match = declRegex.exec(content)) !== null) {
                symbols.push(match[1]);
            }
            
            const fileIndex: FileIndex = {
                path: filePath,
                lastModified: stats.mtimeMs,
                symbols: symbols,
                content: content, // Store original content
                searchContent: content.toLowerCase() // Store lowercase for fast searching
            };
            
            if (type === 'dependency') {
                this.index.dependencies.set(filePath, fileIndex);
            } else if (type === 'stdlib') {
                this.index.stdlib.set(filePath, fileIndex);
            } else { // workspace
                this.index.workspace.set(filePath, fileIndex);
            }
        } catch (error) {
            // Ignore individual file errors
        }
    }
    
    private async saveIndex() {
        try {
            const jsonIndex = {
                version: this.index.version,
                lastUpdated: Date.now(),
                workspacePath: this.index.workspacePath,
                goModHash: this.index.goModHash,
                goVersion: this.index.goVersion,
                workspace: Array.from(this.index.workspace.entries()),
                dependencies: Array.from(this.index.dependencies.entries()),
                stdlib: Array.from(this.index.stdlib.entries())
            };
            
            fs.writeFileSync(this.indexPath, JSON.stringify(jsonIndex), 'utf8');
        } catch (error) {
            console.error('Failed to save index:', error);
        }
    }
    
    async updateDependencyIndex() {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) {
            return;
        }
        
        // Check if go.mod actually changed
        const currentGoModHash = await this.getGoModHash();
        if (currentGoModHash === this.index.goModHash) {
            return; // No changes
        }
        
        console.log('Updating dependency index...');
        
        // Clear dependencies but keep stdlib and workspace
        this.index.dependencies.clear();
        this.index.goModHash = currentGoModHash;
        
        // Re-index dependencies only
        await this.indexDependencies();
        await this.saveIndex();
        
        console.log('Dependency index updated');
    }
    
    async searchInIndex(pattern: string): Promise<{
        workspace: Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
        dependencies: Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
        stdlib: Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>
    }> {
        const results = {
            workspace: [] as Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
            dependencies: [] as Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
            stdlib: [] as Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>
        };
        
        const searchPattern = pattern.toLowerCase();
        console.log(`Searching index: ${this.index.workspace.size} workspace files, ${this.index.dependencies.size} dependency files, ${this.index.stdlib.size} stdlib files`);
        
        // Search in workspace
        for (const [filePath, fileIndex] of this.index.workspace) {
            const matches = this.searchInFileIndex(fileIndex, searchPattern);
            if (matches.length > 0) {
                results.workspace.push({filePath, matches});
            }
        }
        
        // Search in dependencies
        for (const [filePath, fileIndex] of this.index.dependencies) {
            const matches = this.searchInFileIndex(fileIndex, searchPattern);
            if (matches.length > 0) {
                results.dependencies.push({filePath, matches});
            }
        }
        
        // Search in stdlib
        for (const [filePath, fileIndex] of this.index.stdlib) {
            const matches = this.searchInFileIndex(fileIndex, searchPattern);
            if (matches.length > 0) {
                results.stdlib.push({filePath, matches});
            }
        }
        
        console.log(`Index search results: ${results.workspace.length} workspace files, ${results.dependencies.length} dependency files, ${results.stdlib.length} stdlib files matched`);
        return results;
    }
    
    // Search within a FileIndex using both search content and original content
    private searchInFileIndex(fileIndex: FileIndex, pattern: string): Array<{lineNumber: number, lineContent: string}> {
        const matches: Array<{lineNumber: number, lineContent: string}> = [];
        const searchLines = fileIndex.searchContent.split('\n'); // lowercase for searching
        const originalLines = fileIndex.content.split('\n'); // original for display
        const maxMatchesPerFile = 10; // Limit matches per file for performance
        
        for (let i = 0; i < searchLines.length && matches.length < maxMatchesPerFile; i++) {
            if (searchLines[i].includes(pattern)) { // search in lowercase
                matches.push({
                    lineNumber: i,
                    lineContent: originalLines[i] // return original case for display
                });
            }
        }
        
        return matches;
    }
    
    hasIndex(): boolean {
        const hasContent = this.index.dependencies.size > 0 || this.index.stdlib.size > 0 || this.index.workspace.size > 0;
        if (hasContent) {
            console.log(`Index contains: ${this.index.dependencies.size} dependency files, ${this.index.stdlib.size} stdlib files, ${this.index.workspace.size} workspace files`);
        }
        return hasContent;
    }
    
    dispose() {
        if (this.goModWatcher) {
            this.goModWatcher.dispose();
        }
        if (this.workspaceFileWatcher) {
            this.workspaceFileWatcher.dispose();
        }
        if (this.updateTimeout) {
            clearTimeout(this.updateTimeout);
        }
        if (this.workspaceUpdateTimeout) {
            clearTimeout(this.workspaceUpdateTimeout);
        }
        if (this.periodicCheckInterval) {
            clearInterval(this.periodicCheckInterval);
        }
    }

    // Add method to list all workspace indexes
    static async listWorkspaceIndexes(globalStorageDir: string): Promise<Array<{
        workspaceName: string;
        indexPath: string;
        lastUpdated: Date;
        size: number;
    }>> {
        const indexes: Array<{
            workspaceName: string;
            indexPath: string;
            lastUpdated: Date;
            size: number;
        }> = [];
        
        try {
            if (!fs.existsSync(globalStorageDir)) {
                return indexes;
            }
            
            const files = fs.readdirSync(globalStorageDir);
            
            for (const file of files) {
                if (file.startsWith('go-search-index-') && file.endsWith('.json')) {
                    const indexPath = path.join(globalStorageDir, file);
                    try {
                        const stats = fs.statSync(indexPath);
                        const data = fs.readFileSync(indexPath, 'utf8');
                        const jsonIndex = JSON.parse(data);
                        
                        const workspaceName = jsonIndex.workspacePath ? 
                            path.basename(jsonIndex.workspacePath) : 
                            'Unknown';
                        
                        indexes.push({
                            workspaceName,
                            indexPath,
                            lastUpdated: new Date(jsonIndex.lastUpdated || 0),
                            size: stats.size
                        });
                    } catch (error) {
                        // Ignore corrupted index files
                    }
                }
            }
        } catch (error) {
            console.error('Failed to list workspace indexes:', error);
        }
        
        return indexes.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
    }
} 