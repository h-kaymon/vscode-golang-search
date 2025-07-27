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
    private workspaceFileWatcher?: vscode.FileSystemWatcher;
    private moduleFileWatcher?: vscode.FileSystemWatcher;
    private workspaceUpdateTimeout?: NodeJS.Timeout;
    private isBuilding: boolean = false;  // Track if index is being built
    private context!: vscode.ExtensionContext;  // Store context for cleanup operations
    
    constructor(context: vscode.ExtensionContext) {
        try {
            console.log('GoIndexer: Starting initialization...');
            
            this.context = context;  // Store context
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
            
            console.log(`GoIndexer: Workspace ID = ${this.currentWorkspace}`);
            console.log(`GoIndexer: Index path = ${this.indexPath}`);
            
            // Ensure storage directory exists
            try {
                if (!fs.existsSync(context.globalStorageUri.fsPath)) {
                    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
                    console.log(`GoIndexer: Created storage directory ${context.globalStorageUri.fsPath}`);
                }
            } catch (fsError) {
                console.error('GoIndexer: Failed to create storage directory:', fsError);
                // Continue without throwing - we can still work without persistent storage
            }
            
            // Defer file watchers setup to avoid blocking
            setTimeout(() => {
                try {
                    console.log('GoIndexer: Setting up file watchers...');
                    this.setupFileWatchers();
                    console.log('GoIndexer: File watchers setup complete');
                } catch (watcherError) {
                    console.error('GoIndexer: Failed to setup file watchers:', watcherError);
                }
            }, 100);
            
            // Defer periodic check setup to avoid blocking
            setTimeout(() => {
                try {
                    console.log('GoIndexer: Setting up periodic check...');
                    this.setupPeriodicCheck(context);
                    console.log('GoIndexer: Periodic check setup complete');
                } catch (periodicError) {
                    console.error('GoIndexer: Failed to setup periodic check:', periodicError);
                }
            }, 200);
            
            console.log('GoIndexer: Initialization completed successfully');
            
        } catch (error) {
            console.error('GoIndexer: Critical initialization error:', error);
            // Initialize with minimal state to avoid complete failure
            this.currentWorkspace = 'error-workspace';
            this.indexPath = '';
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
        }
    }
    
    // Check if index is currently being built
    isIndexBuilding(): boolean {
        return this.isBuilding;
    }
    
    // Get human-readable status
    getIndexStatus(): string {
        if (this.isBuilding) {
            return 'Building index...';
        }
        if (this.hasIndex()) {
            return `Index ready (${this.index.workspace.size + this.index.dependencies.size + this.index.stdlib.size} files)`;
        }
        return 'No index available';
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
    
    private getIndexPaths(storageDir: string): {
        meta: string;
        workspace: string;
        dependencies: string;
        stdlib: string;
        legacy: string;
    } {
        const workspaceHash = this.hashString(this.currentWorkspace);
        const baseName = `go-search-index-${workspaceHash}`;
        return {
            meta: path.join(storageDir, `${baseName}-meta.json`),
            workspace: path.join(storageDir, `${baseName}-workspace.json`),
            dependencies: path.join(storageDir, `${baseName}-dependencies.json`),
            stdlib: path.join(storageDir, `${baseName}-stdlib.json`),
            legacy: path.join(storageDir, `${baseName}.json`) // old single file format
        };
    }

    private getIndexPath(storageDir: string): string {
        // Keep for backward compatibility, return meta path
        return this.getIndexPaths(storageDir).meta;
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
    
    private setupWorkspaceFileWatcher() {
        if (this.workspaceFileWatcher) {
            this.workspaceFileWatcher.dispose();
        }
        if (this.moduleFileWatcher) {
            this.moduleFileWatcher.dispose();
        }
        
        // Watch Go files in workspace
        this.workspaceFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.go');
        
        // Watch Go module files
        this.moduleFileWatcher = vscode.workspace.createFileSystemWatcher('**/{go.mod,go.sum,go.work}');
        
        const scheduleWorkspaceUpdate = (uri: vscode.Uri) => {
            if (this.workspaceUpdateTimeout) {
                clearTimeout(this.workspaceUpdateTimeout);
            }
            this.workspaceUpdateTimeout = setTimeout(() => {
                this.updateWorkspaceFile(uri.fsPath);
            }, 1000); // 1 second debounce for workspace files
        };
        
        // Setup Go files watcher
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

        // Setup module files watcher
        this.moduleFileWatcher.onDidChange((uri) => {
            scheduleWorkspaceUpdate(uri);
        });
        
        this.moduleFileWatcher.onDidCreate((uri) => {
            scheduleWorkspaceUpdate(uri);
        });
        
        this.moduleFileWatcher.onDidDelete((uri) => {
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
            const paths = this.getIndexPaths(path.dirname(this.indexPath));
            
            // Try to load new split format first
            if (fs.existsSync(paths.meta)) {
                return await this.loadSplitIndex(paths);
            }
            
            // Fall back to legacy single file format
            if (fs.existsSync(paths.legacy)) {
                console.log('Found legacy single index file...');
                
                // Check file size before attempting to load
                const stats = fs.statSync(paths.legacy);
                const fileSizeMB = stats.size / (1024 * 1024);
                console.log(`Legacy index file size: ${fileSizeMB.toFixed(2)}MB`);
                
                // If file is too large (>100MB), skip loading and force rebuild
                if (stats.size > 100 * 1024 * 1024) {
                    console.log('Legacy index file too large (>100MB), skipping load and forcing rebuild...');
                    try {
                        fs.unlinkSync(paths.legacy);
                        console.log('Removed oversized legacy index file');
                    } catch (error) {
                        console.log('Warning: Could not remove oversized legacy file:', error);
                    }
                    return false;
                }
                
                console.log('Attempting to load and migrate legacy index...');
                const success = await this.loadLegacyIndex(paths.legacy);
                if (success) {
                    // Migrate to split format
                    await this.saveIndex();
                }
                return success;
            }
            
            console.log('No index files found');
            return false;
        } catch (error) {
            console.error('Failed to load index:', error);
            
            // If loading failed due to corrupted or oversized files, clean them up
            try {
                const paths = this.getIndexPaths(path.dirname(this.indexPath));
                if (fs.existsSync(paths.legacy)) {
                    console.log('Cleaning up problematic legacy index file...');
                    fs.unlinkSync(paths.legacy);
                }
                // Also clean up potentially corrupted split files
                for (const splitPath of [paths.meta, paths.workspace, paths.dependencies, paths.stdlib]) {
                    if (fs.existsSync(splitPath)) {
                        fs.unlinkSync(splitPath);
                    }
                }
                console.log('Cleaned up problematic index files, will rebuild from scratch');
            } catch (cleanupError) {
                console.error('Failed to cleanup corrupted index files:', cleanupError);
            }
            
            return false;
        }
    }
    
    private async loadSplitIndex(paths: any): Promise<boolean> {
        try {
            console.log('Loading split index format...');
            
            // Load metadata first
            const metaData = fs.readFileSync(paths.meta, 'utf8');
            const metadata = JSON.parse(metaData);
            
            // Validate metadata
            if (metadata.format !== 'split') {
                console.log('Invalid split index format');
                return false;
            }
            
            // Check workspace compatibility
            const currentWorkspace = await this.getCurrentWorkspaceId();
            if (metadata.workspacePath !== currentWorkspace) {
                console.log('Index is for different workspace, rebuilding...');
                return false;
            }
            
            // Check version compatibility
            if (metadata.version !== '2.1') {
                console.log('Index version outdated, rebuilding...');
                return false;
            }
            
            // Check if go.mod has changed
            const currentGoModHash = await this.getGoModHash();
            if (currentGoModHash !== metadata.goModHash) {
                console.log('go.mod has changed, rebuilding index...');
                return false;
            }
            
            // Load index parts in parallel
            const [workspaceData, dependenciesData, stdlibData] = await Promise.all([
                this.loadIndexPart(paths.workspace),
                this.loadIndexPart(paths.dependencies),
                this.loadIndexPart(paths.stdlib)
            ]);
            
            // Reconstruct index
            this.index = {
                version: metadata.version,
                lastUpdated: metadata.lastUpdated,
                workspacePath: metadata.workspacePath,
                goModHash: metadata.goModHash,
                goVersion: metadata.goVersion,
                workspace: new Map(workspaceData),
                dependencies: new Map(dependenciesData),
                stdlib: new Map(stdlibData)
            };
            
            console.log(`Loaded split index: ${this.index.workspace.size} workspace, ${this.index.dependencies.size} dependencies, ${this.index.stdlib.size} stdlib files`);
            return true;
        } catch (error) {
            console.error('Failed to load split index:', error);
            return false;
        }
    }
    
    private async loadIndexPart(filePath: string): Promise<any[]> {
        try {
            if (!fs.existsSync(filePath)) {
                console.log(`Index part file does not exist: ${filePath}`);
                
                // Check if this might be a multi-file format
                const metaPath = filePath.replace('.json', '-meta.json');
                if (fs.existsSync(metaPath)) {
                    console.log(`Found multi-file metadata: ${metaPath}`);
                    return await this.loadIndexPartMultiFile(filePath);
                }
                
                return [];
            }
            
            // Check file size before reading to avoid "Invalid string length" errors
            const stats = fs.statSync(filePath);
            const fileSizeMB = stats.size / (1024 * 1024);
            console.log(`Loading index part: ${path.basename(filePath)} (${fileSizeMB.toFixed(2)}MB)`);
            
            // If file is too large (>200MB), skip it to avoid string length issues
            if (stats.size > 200 * 1024 * 1024) {
                console.log(`Index part file too large (${fileSizeMB.toFixed(2)}MB), skipping: ${filePath}`);
                
                // Remove the problematic file
                try {
                    fs.unlinkSync(filePath);
                    console.log(`Removed oversized index part file: ${filePath}`);
                } catch (deleteError) {
                    console.error(`Failed to remove oversized file: ${filePath}`, deleteError);
                }
                
                return [];
            }
            
            // Read file with additional string length protection
            let data: string;
            try {
                data = fs.readFileSync(filePath, 'utf8');
            } catch (readError: any) {
                if (readError.message && readError.message.includes('Invalid string length')) {
                    console.log(`File read caused string length error, removing: ${filePath}`);
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`Removed problematic file: ${filePath}`);
                    } catch (deleteError) {
                        console.error(`Failed to remove problematic file: ${filePath}`, deleteError);
                    }
                }
                throw readError;
            }
            
            // Check string length before JSON parsing
            const dataLengthMB = data.length / (1024 * 1024);
            if (data.length > 100 * 1024 * 1024) { // 100MB string limit
                console.log(`Index part data too large for JSON parsing (${dataLengthMB.toFixed(2)}MB), skipping: ${filePath}`);
                
                // Remove the problematic file
                try {
                    fs.unlinkSync(filePath);
                    console.log(`Removed unparseable index part file: ${filePath}`);
                } catch (deleteError) {
                    console.error(`Failed to remove unparseable file: ${filePath}`, deleteError);
                }
                
                return [];
            }
            
            // Parse JSON with error handling
            let parsed: any;
            try {
                parsed = JSON.parse(data);
            } catch (parseError: any) {
                console.error(`JSON parse error for ${filePath}:`, parseError);
                
                if (parseError.message && parseError.message.includes('Invalid string length')) {
                    console.log(`JSON parsing caused string length error, removing: ${filePath}`);
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`Removed unparseable file: ${filePath}`);
                    } catch (deleteError) {
                        console.error(`Failed to remove unparseable file: ${filePath}`, deleteError);
                    }
                }
                
                return [];
            }
            
            // Handle chunked format for large files
            if (parsed.chunks && Array.isArray(parsed.chunks)) {
                console.log(`Loading chunked index part: ${parsed.totalEntries} total entries from ${parsed.chunks.length} chunks`);
                const result = [];
                
                // Process chunks with safety limits
                let processedEntries = 0;
                const maxEntries = 50000; // Limit to prevent memory issues
                
                for (const chunk of parsed.chunks) {
                    if (Array.isArray(chunk)) {
                        if (processedEntries + chunk.length > maxEntries) {
                            console.log(`Reached entry limit (${maxEntries}), truncating remaining chunks`);
                            const remainingSlots = maxEntries - processedEntries;
                            if (remainingSlots > 0) {
                                result.push(...chunk.slice(0, remainingSlots));
                            }
                            break;
                        }
                        result.push(...chunk);
                        processedEntries += chunk.length;
                    }
                }
                
                console.log(`Loaded ${result.length} entries from chunked format`);
                return result;
            }
            
            // Handle regular array format
            if (Array.isArray(parsed)) {
                // Limit array size to prevent memory issues
                const maxEntries = 50000;
                if (parsed.length > maxEntries) {
                    console.log(`Array too large (${parsed.length} entries), truncating to ${maxEntries}`);
                    return parsed.slice(0, maxEntries);
                }
                
                console.log(`Loaded ${parsed.length} entries from array format`);
                return parsed;
            }
            
            console.log(`Unknown format in ${filePath}, returning empty array`);
            return [];
            
        } catch (error) {
            console.error(`Failed to load index part ${filePath}:`, error);
            
            // If it's a string length error, try to remove the problematic file
            if (error && typeof error === 'object' && 'message' in error && 
                typeof (error as any).message === 'string' && 
                (error as any).message.includes('Invalid string length')) {
                console.log(`String length error detected, attempting to remove problematic file: ${filePath}`);
                try {
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                        console.log(`Successfully removed problematic file: ${filePath}`);
                    }
                } catch (deleteError) {
                    console.error(`Failed to remove problematic file: ${filePath}`, deleteError);
                }
            }
            
            return [];
        }
    }
    
    // Load multi-file format
    private async loadIndexPartMultiFile(basePath: string): Promise<any[]> {
        try {
            const metaPath = basePath.replace('.json', '-meta.json');
            
            if (!fs.existsSync(metaPath)) {
                console.log(`Multi-file metadata not found: ${metaPath}`);
                return [];
            }
            
            // Load metadata
            const metaData = fs.readFileSync(metaPath, 'utf8');
            const metadata = JSON.parse(metaData);
            
            if (metadata.type !== 'multi-file') {
                console.log(`Invalid multi-file metadata type: ${metadata.type}`);
                return [];
            }
            
            console.log(`Loading multi-file index: ${metadata.totalEntries} entries from ${metadata.totalFiles} files`);
            
            const result = [];
            let loadedFiles = 0;
            let loadedEntries = 0;
            
            // Load all part files
            for (let fileIndex = 0; fileIndex < metadata.totalFiles; fileIndex++) {
                const partPath = basePath.replace('.json', `-part${fileIndex}.json`);
                
                try {
                    if (fs.existsSync(partPath)) {
                        const partData = fs.readFileSync(partPath, 'utf8');
                        const partEntries = JSON.parse(partData);
                        
                        if (Array.isArray(partEntries)) {
                            result.push(...partEntries);
                            loadedEntries += partEntries.length;
                            loadedFiles++;
                            console.log(`Loaded part ${fileIndex}: ${partEntries.length} entries`);
                        }
                    } else {
                        console.log(`Part file missing: ${partPath}`);
                    }
                } catch (partError) {
                    console.error(`Failed to load part ${fileIndex}:`, partError);
                    // Continue with other parts
                }
                
                // Safety limit
                if (loadedEntries >= 50000) {
                    console.log(`Reached safety limit (50K entries), stopping multi-file load`);
                    break;
                }
            }
            
            console.log(`Multi-file load completed: ${loadedEntries} entries from ${loadedFiles}/${metadata.totalFiles} files`);
            return result;
            
        } catch (error) {
            console.error(`Failed to load multi-file index:`, error);
            return [];
        }
    }
    
    private async loadLegacyIndex(legacyPath: string): Promise<boolean> {
        try {
            console.log('Loading legacy index format...');
            
            // Additional safety check - verify file size again
            const stats = fs.statSync(legacyPath);
            if (stats.size > 50 * 1024 * 1024) { // 50MB limit for JSON parsing
                console.log(`Legacy file too large for safe parsing: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
                return false;
            }
            
            // Read file in chunks to avoid memory issues
            const data = fs.readFileSync(legacyPath, 'utf8');
            console.log(`Read legacy index data: ${(data.length / 1024 / 1024).toFixed(2)}MB`);
            
            // Check string length before JSON parsing
            if (data.length > 50 * 1024 * 1024) { // 50MB string limit
                console.log('Legacy index string too large for JSON parsing, skipping...');
                return false;
            }
            
            const jsonIndex = JSON.parse(data);
            
            // Convert maps from JSON
            this.index = {
                version: jsonIndex.version || '1.0',
                lastUpdated: jsonIndex.lastUpdated,
                workspacePath: jsonIndex.workspacePath,
                goModHash: jsonIndex.goModHash || '',
                goVersion: jsonIndex.goVersion || '',
                workspace: new Map(jsonIndex.workspace || []),
                dependencies: new Map(jsonIndex.dependencies || []),
                stdlib: new Map(jsonIndex.stdlib || [])
            };
            
            // Check workspace compatibility
            const currentWorkspace = await this.getCurrentWorkspaceId();
            if (this.index.workspacePath !== currentWorkspace) {
                console.log('Legacy index is for different workspace, rebuilding...');
                return false;
            }
            
            // Check version compatibility
            if (this.index.version !== '2.1') {
                console.log('Legacy index version outdated, rebuilding...');
                return false;
            }
            
            console.log(`Loaded legacy index: ${this.index.workspace.size} workspace, ${this.index.dependencies.size} dependencies, ${this.index.stdlib.size} stdlib files`);
            return true;
        } catch (error) {
            console.error('Failed to load legacy index:', error);
            
            // If it's a string length error, the file is definitely too large
            if (error && typeof error === 'object' && 'message' in error && 
                typeof (error as any).message === 'string' && 
                (error as any).message.includes('Invalid string length')) {
                console.log('Legacy index file caused "Invalid string length" error, removing it...');
                try {
                    fs.unlinkSync(legacyPath);
                    console.log('Removed problematic legacy index file');
                } catch (deleteError) {
                    console.error('Failed to remove problematic legacy file:', deleteError);
                }
            }
            
            return false;
        }
    }
    
    async buildIndex(progress?: vscode.Progress<{
        message?: string;
        increment?: number;
    }>) {
        this.isBuilding = true;
        const workspaceDisplayName = this.getWorkspaceDisplayName();
        progress?.report({ message: `Building Go index for ${workspaceDisplayName}...` });
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log('No workspace folders available for indexing');
            this.isBuilding = false;
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
        this.isBuilding = false;
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
                
                // Index .go files
                const { stdout: goFiles } = await execPromise(`find "${workspacePath}" -maxdepth 10 -name "*.go" -type f | head -20000`, {
                    maxBuffer: 1024 * 1024 * 100
                });

                const files = goFiles.trim().split('\n').filter(Boolean);
                console.log(`Found ${files.length} Go files in workspace: ${folder.name}`);
                
                for (const file of files) {
                    await this.indexFile(file, 'workspace');
                }

                // Index Go module files (go.mod, go.sum, go.work)
                const { stdout: modFiles } = await execPromise(`find "${workspacePath}" -maxdepth 3 \\( -name "go.mod" -o -name "go.sum" -o -name "go.work" \\) -type f`, {
                    maxBuffer: 1024 * 1024 * 10
                });

                const moduleFiles = modFiles.trim().split('\n').filter(Boolean);
                console.log(`Found ${moduleFiles.length} Go module files in workspace: ${folder.name}`);
                
                for (const file of moduleFiles) {
                    await this.indexFile(file, 'workspace');
                }
            }
            
            console.log(`Indexed ${this.index.workspace.size} workspace files (including .go and module files)`);
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
            console.log('Starting to index project-specific dependencies...');
            
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                console.log('No workspace folders available for dependency indexing');
                return;
            }

            // Index dependencies for each workspace folder
            for (const workspaceFolder of workspaceFolders) {
                console.log(`Indexing dependencies for workspace: ${workspaceFolder.name}`);
                await this.indexWorkspaceDependencies(workspaceFolder.uri.fsPath);
            }
            
            console.log(`Finished indexing dependencies. Total: ${this.index.dependencies.size} files`);
            
        } catch (error) {
            console.error('Failed to index dependencies:', error);
        }
    }
    
    // Index only the specific dependencies used by this workspace
    private async indexWorkspaceDependencies(workspacePath: string) {
        try {
            // Step 1: Get the exact list of dependencies used by this project
            const projectDeps = await this.getProjectDependencies(workspacePath);
            console.log(`Found ${projectDeps.length} project dependencies`);
            
            if (projectDeps.length === 0) {
                console.log('No dependencies found for this project');
                return;
            }
            
            // Log sample dependencies for verification
            const sampleDeps = projectDeps.slice(0, 5).map(dep => `${dep.module} ${dep.version}`);
            console.log('Sample dependencies:', sampleDeps);
            
            // Step 2: Get Go module cache path
            const goModCachePath = await this.getGoModCachePath();
            console.log(`Go module cache path: ${goModCachePath}`);
            
            if (!fs.existsSync(goModCachePath)) {
                console.log('Go module cache not found, skipping dependency indexing');
                return;
            }
            
            // Step 3: Index only the specific versions used by this project
            let indexedCount = 0;
            let skippedCount = 0;
            
            for (const dep of projectDeps) {
                try {
                    const depPath = this.getDependencyPath(goModCachePath, dep);
                    if (fs.existsSync(depPath)) {
                        const fileCount = await this.indexDependencyFiles(depPath, dep);
                        indexedCount += fileCount;
                        
                        if (dep.module.includes('aws')) {
                            console.log(`✅ Indexed AWS dependency: ${dep.module}@${dep.version} (${fileCount} files)`);
                        }
                    } else {
                        skippedCount++;
                        if (dep.module.includes('aws') || dep.module.includes('gin')) {
                            console.log(`⚠️ Dependency path not found: ${dep.module}@${dep.version} -> ${depPath}`);
                        }
                    }
                } catch (depError) {
                    console.error(`Failed to index dependency ${dep.module}:`, depError);
                    skippedCount++;
                }
            }
            
            console.log(`Dependency indexing completed: ${indexedCount} files indexed, ${skippedCount} dependencies skipped`);
            
            // Step 4: Also index vendor directory if it exists (for vendored dependencies)
            const vendorPath = path.join(workspacePath, 'vendor');
            if (fs.existsSync(vendorPath)) {
                console.log(`Indexing vendor directory: ${vendorPath}`);
                const vendorFileCount = await this.indexVendorDirectory(vendorPath);
                console.log(`Indexed ${vendorFileCount} files from vendor directory`);
            }
            
        } catch (error) {
            console.error(`Failed to index dependencies for ${workspacePath}:`, error);
        }
    }
    
    // Get the exact list of dependencies used by this project
    private async getProjectDependencies(workspacePath: string): Promise<Array<{module: string, version: string, path?: string}>> {
        try {
            console.log(`Getting project dependencies for: ${workspacePath}`);
            
            // Use 'go list -m all' to get the exact dependencies used by this project
            const { stdout } = await execPromise('go list -m all', {
                cwd: workspacePath,
                maxBuffer: 1024 * 1024 * 10 // 10MB buffer
            });
            
            const lines = stdout.trim().split('\n').filter(Boolean);
            const dependencies = [];
            
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine) continue;
                
                // Parse dependency line: "module version [replacement]"
                // Examples:
                // github.com/gin-gonic/gin v1.9.1
                // github.com/aws/aws-sdk-go-v2/service/s3 v1.40.0
                // golang.org/x/net v0.10.0 => golang.org/x/net v0.10.0
                
                let module = '';
                let version = '';
                
                if (trimmedLine.includes(' => ')) {
                    // Handle replacements: "original => replacement"
                    const parts = trimmedLine.split(' => ');
                    const replacementPart = parts[1].trim();
                    const replacementTokens = replacementPart.split(/\s+/);
                    if (replacementTokens.length >= 2) {
                        module = replacementTokens[0];
                        version = replacementTokens[1];
                    }
                } else {
                    // Normal dependency: "module version"
                    const tokens = trimmedLine.split(/\s+/);
                    if (tokens.length >= 2) {
                        module = tokens[0];
                        version = tokens[1];
                    }
                }
                
                // Skip the main module (first line) and invalid entries
                if (module && version && version !== '' && !module.endsWith('/...')) {
                    // Skip pseudo-versions and local replacements
                    if (!version.startsWith('./') && !version.startsWith('../') && version !== '(devel)') {
                        dependencies.push({ module, version });
                    }
                }
            }
            
            // Filter out the main module (it should not be in dependencies)
            const filteredDeps = dependencies.filter(dep => !dep.module.includes(path.basename(workspacePath)));
            
            console.log(`Parsed ${filteredDeps.length} valid dependencies from go list -m all`);
            return filteredDeps;
            
        } catch (error) {
            console.error('Failed to get project dependencies:', error);
            
            // Fallback: try to parse go.mod file directly
            try {
                return await this.parseGoModFile(workspacePath);
            } catch (fallbackError) {
                console.error('Fallback go.mod parsing also failed:', fallbackError);
                return [];
            }
        }
    }
    
    // Fallback: parse go.mod file directly if 'go list -m all' fails
    private async parseGoModFile(workspacePath: string): Promise<Array<{module: string, version: string}>> {
        try {
            const goModPath = path.join(workspacePath, 'go.mod');
            if (!fs.existsSync(goModPath)) {
                console.log('go.mod file not found');
                return [];
            }
            
            const goModContent = fs.readFileSync(goModPath, 'utf8');
            const dependencies = [];
            
            // Parse go.mod require block
            const requireBlockMatch = goModContent.match(/require\s*\(([\s\S]*?)\)/);
            if (requireBlockMatch) {
                const requireBlock = requireBlockMatch[1];
                const lines = requireBlock.split('\n');
                
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine && !trimmedLine.startsWith('//')) {
                        const tokens = trimmedLine.split(/\s+/);
                        if (tokens.length >= 2) {
                            const module = tokens[0];
                            const version = tokens[1];
                            dependencies.push({ module, version });
                        }
                    }
                }
            }
            
            // Also parse single-line require statements
            const singleRequireRegex = /require\s+(\S+)\s+(\S+)/g;
            let match;
            while ((match = singleRequireRegex.exec(goModContent)) !== null) {
                dependencies.push({ module: match[1], version: match[2] });
            }
            
            console.log(`Parsed ${dependencies.length} dependencies from go.mod file`);
            return dependencies;
            
        } catch (error) {
            console.error('Failed to parse go.mod file:', error);
            return [];
        }
    }
    
    // Get the exact file system path for a specific dependency version
    private getDependencyPath(goModCachePath: string, dep: {module: string, version: string}): string {
        // Go module cache structure: module@version
        // Example: github.com/gin-gonic/gin@v1.9.1
        const versionedModule = `${dep.module}@${dep.version}`;
        return path.join(goModCachePath, versionedModule);
    }
    
    // Index all .go files in a specific dependency directory
    private async indexDependencyFiles(depPath: string, dep: {module: string, version: string}): Promise<number> {
        try {
            // Find all .go files in this specific dependency version
            const { stdout } = await execPromise(`find "${depPath}" -name "*.go" -type f`, {
                maxBuffer: 1024 * 1024 * 50 // 50MB buffer per dependency
            });
            
            const files = stdout.trim().split('\n').filter(Boolean);
            
            if (files.length === 0) {
                return 0;
            }
            
            // Index all files for this dependency
            for (const file of files) {
                await this.indexFile(file, 'dependency');
            }
            
            return files.length;
            
        } catch (error) {
            console.error(`Failed to index files for ${dep.module}@${dep.version}:`, error);
            return 0;
        }
    }
    
    // Index vendor directory (for vendored dependencies)
    private async indexVendorDirectory(vendorPath: string): Promise<number> {
        try {
            const { stdout } = await execPromise(`find "${vendorPath}" -name "*.go" -type f | head -5000`, {
                maxBuffer: 1024 * 1024 * 50
            });

            const vendorFiles = stdout.trim().split('\n').filter(Boolean);
            
            for (const file of vendorFiles) {
                await this.indexFile(file, 'dependency');
            }
            
            return vendorFiles.length;
            
        } catch (error) {
            console.error('Failed to index vendor directory:', error);
            return 0;
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

    private async getGoModCachePath(): Promise<string> {
        const { stdout: gomodcache } = await execPromise('go env GOMODCACHE');
        return gomodcache.trim() || path.join(await this.getGoPath(), 'pkg', 'mod');
    }

    private async getGoPath(): Promise<string> {
        const { stdout: gopath } = await execPromise('go env GOPATH');
        return gopath.trim();
    }
    
    private async indexFile(filePath: string, type: 'dependency' | 'stdlib' | 'workspace') {
        try {
            const stats = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf8');
            
            // Extract symbols (function names, type names, etc.) only for Go files
            const symbols: string[] = [];
            const isGoFile = filePath.endsWith('.go');
            
            if (isGoFile) {
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
            } else {
                // For non-Go files (like go.mod), extract simple patterns
                if (filePath.endsWith('go.mod') || filePath.endsWith('go.sum')) {
                    // Extract module names and versions
                    const moduleRegex = /(?:require|module)\s+([\w\-\.\/]+)/g;
                    let match;
                    while ((match = moduleRegex.exec(content)) !== null) {
                        symbols.push(match[1]);
                    }
                }
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
            console.log(`Failed to index file ${filePath}:`, error);
        }
    }
    
    private async saveIndex() {
        try {
            const paths = this.getIndexPaths(path.dirname(this.indexPath));
            
            // Save metadata (small file with basic info)
            const metadata = {
                version: this.index.version,
                lastUpdated: Date.now(),
                workspacePath: this.index.workspacePath,
                goModHash: this.index.goModHash,
                goVersion: this.index.goVersion,
                workspaceCount: this.index.workspace.size,
                dependenciesCount: this.index.dependencies.size,
                stdlibCount: this.index.stdlib.size,
                format: 'split' // indicate this is the new split format
            };
            
            console.log(`Saving split index: ${metadata.workspaceCount} workspace, ${metadata.dependenciesCount} dependencies, ${metadata.stdlibCount} stdlib files`);
            
            // Save each index type separately to avoid large JSON strings
            await Promise.all([
                this.saveIndexPart(paths.meta, metadata),
                this.saveIndexPart(paths.workspace, Array.from(this.index.workspace.entries())),
                this.saveIndexPart(paths.dependencies, Array.from(this.index.dependencies.entries())),
                this.saveIndexPart(paths.stdlib, Array.from(this.index.stdlib.entries()))
            ]);
            
            // Clean up legacy single file if it exists
            if (fs.existsSync(paths.legacy)) {
                try {
                    fs.unlinkSync(paths.legacy);
                    console.log('Removed legacy single index file');
                } catch (error) {
                    console.log('Warning: Could not remove legacy index file:', error);
                }
            }
            
            console.log('Successfully saved split index files');
        } catch (error) {
            console.error('Failed to save index:', error);
            throw error;
        }
    }
    
    private async saveIndexPart(filePath: string, data: any) {
        try {
            // For non-array data, save directly (usually small metadata)
            if (!Array.isArray(data)) {
                try {
                    const jsonString = JSON.stringify(data);
                    if (jsonString.length > 10 * 1024 * 1024) { // 10MB limit for non-arrays
                        console.log(`Non-array data too large (${(jsonString.length / 1024 / 1024).toFixed(2)}MB), skipping: ${filePath}`);
                        return;
                    }
                    fs.writeFileSync(filePath, jsonString, 'utf8');
                    return;
                } catch (stringifyError: any) {
                    if (stringifyError.message && stringifyError.message.includes('Invalid string length')) {
                        console.log(`Non-array data caused string length error, skipping: ${filePath}`);
                        return;
                    }
                    throw stringifyError;
                }
            }

            // For arrays, implement ultra-aggressive chunking strategy
            const arrayData = data as any[];
            const arrayLength = arrayData.length;
            
            console.log(`Saving index part with ${arrayLength} entries: ${path.basename(filePath)}`);
            
            // If array is small enough, try direct save first
            if (arrayLength <= 1000) {
                try {
                    const jsonString = JSON.stringify(arrayData);
                    if (jsonString.length <= 20 * 1024 * 1024) { // 20MB limit for small arrays
                        fs.writeFileSync(filePath, jsonString, 'utf8');
                        console.log(`Saved small array directly: ${arrayLength} entries`);
                        return;
                    }
                } catch (directSaveError: any) {
                    console.log(`Direct save failed for small array, falling back to chunking: ${directSaveError.message}`);
                }
            }
            
            // For large arrays or failed direct saves, use multi-file chunking
            if (arrayLength > 10000) {
                console.log(`Array too large (${arrayLength} entries), using multi-file strategy`);
                await this.saveIndexPartMultiFile(filePath, arrayData);
                return;
            }
            
            // For medium arrays (1000-10000), use ultra-small chunks
            console.log(`Using ultra-small chunk strategy for ${arrayLength} entries`);
            const ultraSmallChunkSize = Math.min(500, Math.max(100, Math.floor(arrayLength / 10))); // 100-500 entries per chunk
            const chunks = [];
            
            for (let i = 0; i < arrayLength; i += ultraSmallChunkSize) {
                const chunk = arrayData.slice(i, i + ultraSmallChunkSize);
                chunks.push(chunk);
                
                // Test chunk size to ensure it's safe
                try {
                    const testChunkString = JSON.stringify(chunk);
                    if (testChunkString.length > 50 * 1024 * 1024) { // 50MB per chunk limit
                        console.log(`Chunk ${i / ultraSmallChunkSize} too large, splitting further`);
                        // Split this chunk further
                        const miniChunkSize = Math.floor(ultraSmallChunkSize / 4);
                        chunks.pop(); // Remove the large chunk
                        for (let j = i; j < Math.min(i + ultraSmallChunkSize, arrayLength); j += miniChunkSize) {
                            chunks.push(arrayData.slice(j, j + miniChunkSize));
                        }
                    }
                } catch (chunkTestError) {
                    console.log(`Chunk test failed, using even smaller chunks`);
                    chunks.pop(); // Remove the problematic chunk
                    const tinyChunkSize = Math.floor(ultraSmallChunkSize / 8);
                    for (let j = i; j < Math.min(i + ultraSmallChunkSize, arrayLength); j += tinyChunkSize) {
                        chunks.push(arrayData.slice(j, j + tinyChunkSize));
                    }
                }
            }
            
            // Save chunked data with additional safety
            try {
                const chunkedData = { chunks, totalEntries: arrayLength, chunkStrategy: 'ultra-small' };
                const chunkedJsonString = JSON.stringify(chunkedData);
                
                // Final size check
                if (chunkedJsonString.length > 100 * 1024 * 1024) { // 100MB final limit
                    console.log(`Chunked data still too large (${(chunkedJsonString.length / 1024 / 1024).toFixed(2)}MB), using multi-file strategy`);
                    await this.saveIndexPartMultiFile(filePath, arrayData);
                    return;
                }
                
                fs.writeFileSync(filePath, chunkedJsonString, 'utf8');
                console.log(`Saved chunked data: ${chunks.length} chunks, ${arrayLength} total entries`);
                
            } catch (chunkedSaveError: any) {
                if (chunkedSaveError.message && chunkedSaveError.message.includes('Invalid string length')) {
                    console.log(`Chunked save caused string length error, using multi-file strategy`);
                    await this.saveIndexPartMultiFile(filePath, arrayData);
                    return;
                }
                throw chunkedSaveError;
            }
            
        } catch (error) {
            console.error(`Failed to save index part ${filePath}:`, error);
            
            // If it's a string length error, try emergency fallback
            if (error && typeof error === 'object' && 'message' in error && 
                typeof (error as any).message === 'string' && 
                (error as any).message.includes('Invalid string length')) {
                console.log(`String length error detected, attempting emergency fallback for ${filePath}`);
                
                try {
                    if (Array.isArray(data)) {
                        await this.saveIndexPartMultiFile(filePath, data);
                        return;
                    }
                } catch (fallbackError) {
                    console.error(`Emergency fallback also failed for ${filePath}:`, fallbackError);
                }
            }
            
            throw error;
        }
    }
    
    // Multi-file strategy for extremely large datasets
    private async saveIndexPartMultiFile(basePath: string, data: any[]) {
        try {
            const maxEntriesPerFile = 2000; // Very conservative
            const totalFiles = Math.ceil(data.length / maxEntriesPerFile);
            
            console.log(`Splitting ${data.length} entries into ${totalFiles} files`);
            
            // Create metadata file
            const metaPath = basePath.replace('.json', '-meta.json');
            const metaData = {
                type: 'multi-file',
                totalEntries: data.length,
                totalFiles: totalFiles,
                maxEntriesPerFile: maxEntriesPerFile,
                basePath: path.basename(basePath, '.json')
            };
            
            fs.writeFileSync(metaPath, JSON.stringify(metaData), 'utf8');
            console.log(`Created multi-file metadata: ${metaPath}`);
            
            // Save data in multiple files
            let savedFiles = 0;
            for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
                const start = fileIndex * maxEntriesPerFile;
                const end = Math.min(start + maxEntriesPerFile, data.length);
                const fileData = data.slice(start, end);
                
                const filePath = basePath.replace('.json', `-part${fileIndex}.json`);
                
                try {
                    // Extra safety check for each file
                    const fileJsonString = JSON.stringify(fileData);
                    if (fileJsonString.length > 30 * 1024 * 1024) { // 30MB per file limit
                        console.log(`File part ${fileIndex} still too large, truncating...`);
                        const truncatedData = fileData.slice(0, Math.floor(fileData.length / 2));
                        fs.writeFileSync(filePath, JSON.stringify(truncatedData), 'utf8');
                        console.log(`Saved truncated file part ${fileIndex}: ${truncatedData.length} entries`);
                    } else {
                        fs.writeFileSync(filePath, fileJsonString, 'utf8');
                        console.log(`Saved file part ${fileIndex}: ${fileData.length} entries`);
                    }
                    savedFiles++;
                } catch (fileError: any) {
                    console.error(`Failed to save file part ${fileIndex}:`, fileError.message);
                    // Continue with other files
                }
            }
            
            console.log(`Multi-file save completed: ${savedFiles}/${totalFiles} files saved`);
            
            // Remove the original single file if it exists
            if (fs.existsSync(basePath)) {
                try {
                    fs.unlinkSync(basePath);
                    console.log(`Removed original single file: ${basePath}`);
                } catch (removeError) {
                    console.log(`Warning: Could not remove original file: ${basePath}`);
                }
            }
            
        } catch (multiFileError) {
            console.error(`Multi-file save strategy failed:`, multiFileError);
            throw multiFileError;
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
    
    async searchInIndex(pattern: string, fuzzy: boolean = false): Promise<{
        workspace: Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
        dependencies: Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
        stdlib: Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>
    }> {
        const results = {
            workspace: [] as Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
            dependencies: [] as Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>,
            stdlib: [] as Array<{filePath: string, matches: Array<{lineNumber: number, lineContent: string}>}>
        };
        
        console.log(`Searching index: ${this.index.workspace.size} workspace files, ${this.index.dependencies.size} dependency files, ${this.index.stdlib.size} stdlib files`);
        console.log(`Search mode: ${fuzzy ? 'Fuzzy (case-insensitive)' : 'Exact (case-sensitive)'}, pattern: "${pattern}"`);
        
        // Search in workspace
        for (const [filePath, fileIndex] of this.index.workspace) {
            const matches = this.searchInFileIndex(fileIndex, pattern, fuzzy);
            if (matches.length > 0) {
                results.workspace.push({filePath, matches});
            }
        }
        
        // Search in dependencies
        for (const [filePath, fileIndex] of this.index.dependencies) {
            const matches = this.searchInFileIndex(fileIndex, pattern, fuzzy);
            if (matches.length > 0) {
                results.dependencies.push({filePath, matches});
            }
        }
        
        // Search in stdlib
        for (const [filePath, fileIndex] of this.index.stdlib) {
            const matches = this.searchInFileIndex(fileIndex, pattern, fuzzy);
            if (matches.length > 0) {
                results.stdlib.push({filePath, matches});
            }
        }
        
        console.log(`Index search results: ${results.workspace.length} workspace files, ${results.dependencies.length} dependency files, ${results.stdlib.length} stdlib files matched`);
        return results;
    }
    
    // Search within a FileIndex using both search content and original content
    private searchInFileIndex(fileIndex: FileIndex, pattern: string, fuzzy: boolean = false): Array<{lineNumber: number, lineContent: string}> {
        const matches: Array<{lineNumber: number, lineContent: string}> = [];
        const searchLines = fileIndex.searchContent.split('\n'); // lowercase for searching
        const originalLines = fileIndex.content.split('\n'); // original for display
        const maxMatchesPerFile = 10; // Limit matches per file for performance
        
        for (let i = 0; i < searchLines.length && matches.length < maxMatchesPerFile; i++) {
            let isMatch = false;
            
            if (fuzzy) {
                // Fuzzy matching: case-insensitive substring search
                isMatch = searchLines[i].includes(pattern.toLowerCase());
            } else {
                // Exact matching: case-sensitive substring search
                isMatch = originalLines[i].includes(pattern);
            }
            
            if (isMatch) {
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
        if (this.moduleFileWatcher) {
            this.moduleFileWatcher.dispose();
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
            const processedHashes = new Set<string>();
            
            for (const file of files) {
                // Look for meta files (new split format) or legacy single files
                if ((file.startsWith('go-search-index-') && file.endsWith('-meta.json')) || 
                    (file.startsWith('go-search-index-') && file.endsWith('.json') && !file.includes('-'))) {
                    
                    const indexPath = path.join(globalStorageDir, file);
                    
                    // Extract workspace hash to avoid duplicates
                    let workspaceHash = '';
                    if (file.endsWith('-meta.json')) {
                        workspaceHash = file.replace('go-search-index-', '').replace('-meta.json', '');
                    } else {
                        workspaceHash = file.replace('go-search-index-', '').replace('.json', '');
                    }
                    
                    if (processedHashes.has(workspaceHash)) {
                        continue; // Skip if already processed
                    }
                    processedHashes.add(workspaceHash);
                    
                    try {
                        let metadata: any = {};
                        let totalSize = 0;
                        
                        if (file.endsWith('-meta.json')) {
                            // New split format
                            const metaData = fs.readFileSync(indexPath, 'utf8');
                            metadata = JSON.parse(metaData);
                            
                            // Calculate total size of all split files
                            const basePath = indexPath.replace('-meta.json', '');
                            const splitPaths = [
                                indexPath, // meta
                                `${basePath}-workspace.json`,
                                `${basePath}-dependencies.json`,
                                `${basePath}-stdlib.json`
                            ];
                            
                            for (const splitPath of splitPaths) {
                                if (fs.existsSync(splitPath)) {
                                    totalSize += fs.statSync(splitPath).size;
                                }
                            }
                        } else {
                            // Legacy single file format
                            const stats = fs.statSync(indexPath);
                            const data = fs.readFileSync(indexPath, 'utf8');
                            metadata = JSON.parse(data);
                            totalSize = stats.size;
                        }
                        
                        const workspaceName = metadata.workspacePath ? 
                            path.basename(metadata.workspacePath) : 
                            'Unknown';
                        
                        indexes.push({
                            workspaceName,
                            indexPath: file.endsWith('-meta.json') ? indexPath.replace('-meta.json', '') : indexPath,
                            lastUpdated: new Date(metadata.lastUpdated || 0),
                            size: totalSize
                        });
                    } catch (error) {
                        // Ignore corrupted index files
                        console.log(`Skipping corrupted index file: ${file}`, error);
                    }
                }
            }
            
            return indexes.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
        } catch (error) {
            console.error('Failed to list workspace indexes:', error);
            return indexes;
        }
    }

    // Public method to get index paths for cleanup operations
    getIndexFilePaths(storageDir: string): {
        meta: string;
        workspace: string;
        dependencies: string;
        stdlib: string;
        legacy: string;
    } {
        return this.getIndexPaths(storageDir);
    }

    // Public method to get storage directory path
    getStorageDirectory(): string {
        return this.context.globalStorageUri.fsPath;
    }
} 