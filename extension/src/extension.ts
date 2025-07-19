import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as util from 'util';
import { getWebviewContent } from './webview';

// 声明console对象以解决类型错误
declare var console: {
    log(message?: any, ...optionalParams: any[]): void;
    error(message?: any, ...optionalParams: any[]): void;
    warn(message?: any, ...optionalParams: any[]): void;
    info(message?: any, ...optionalParams: any[]): void;
};

// 将子进程的exec转换为Promise形式
const execPromise = util.promisify(cp.exec);

// 获取Go模块的依赖路径
async function getGoModCachePath(): Promise<string> {
    try {
        const { stdout } = await execPromise('go env GOMODCACHE');
        return stdout.trim();
    } catch (error) {
        console.error('获取GOMODCACHE失败:', error);
        // 失败时返回默认路径
        return path.join(os.homedir(), 'go', 'pkg', 'mod');
    }
}

// 获取项目的依赖模块
async function getProjectDependencies(workspaceDir: string): Promise<string[]> {
    try {
        // 确保在工作空间目录执行命令
        const options = { cwd: workspaceDir };
        const { stdout } = await execPromise('go list -m all', options);
        
        // 解析输出，移除主模块（第一行）
        const modules = stdout.split('\n').filter(Boolean);
        if (modules.length > 0) {
            // 第一个模块通常是项目本身
            return modules.slice(1);
        }
        return [];
    } catch (error) {
        console.error('获取项目依赖失败:', error);
        return [];
    }
}

// 定义搜索结果来源类型
enum ResultSource {
    Dependency = 'dependency',
    Workspace = 'workspace'
}

// 定义搜索结果类型
interface SearchResult {
    location: vscode.Location;
    content: string;
    source: ResultSource; // 标记结果来自依赖库还是工作区
}

// 全局存储搜索结果
let lastSearchResults: SearchResult[] = [];
let lastSearchText: string = '';

// 搜索视图提供程序 - 使用WebviewView实现带搜索框的视图
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
        
        // 监听来自Webview的消息
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
    
    // 执行搜索并更新结果
    private async performSearch(searchText: string) {
        if (!this._view) {
            return;
        }
        
        this._view.webview.postMessage({ command: 'searchStarted' });
        
        try {
            // 获取当前工作空间
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                this._view.webview.postMessage({ 
                    command: 'searchError', 
                    message: '请先打开一个Go项目工作空间' 
                });
                return;
            }
            
            const workspaceDir = workspaceFolders[0].uri.fsPath;
            const goModPath = path.join(workspaceDir, 'go.mod');
            
            if (!fs.existsSync(goModPath)) {
                this._view.webview.postMessage({ 
                    command: 'searchError', 
                    message: '当前工作空间不是有效的Go模块项目' 
                });
                return;
            }
            
                            // 同时搜索工作区和依赖库
                const [workspaceResults, dependencyResults] = await Promise.all([
                    searchInWorkspace(workspaceDir, searchText),
                    searchInDependencies(workspaceDir, searchText)
                ]);
                
                // 对每个结果集单独排序，非测试文件优先
                const sortWorkspaceResults = (a: SearchResult, b: SearchResult) => {
                    const aIsTest = a.location.uri.fsPath.endsWith('_test.go');
                    const bIsTest = b.location.uri.fsPath.endsWith('_test.go');
                    if (aIsTest && !bIsTest) return 1;
                    if (!aIsTest && bIsTest) return -1;
                    return 0;
                };
                
                // 确保结果集内部也是按照非测试文件优先排序
                const sortedWorkspaceResults = [...workspaceResults].sort(sortWorkspaceResults);
                const sortedDependencyResults = [...dependencyResults].sort(sortWorkspaceResults);
                
                // 合并结果 - 工作区优先，且每个分组中非测试文件优先
                const results = [...sortedWorkspaceResults, ...sortedDependencyResults];
                
                // 保存搜索结果以供树视图使用
                lastSearchResults = results;
                lastSearchText = searchText;
            
            // 刷新树视图
            this._searchResultsProvider.refresh();
            vscode.commands.executeCommand('setContext', 'golang-search.hasResults', true);
            
            // 格式化结果并发送给webview
            const goModCachePath = await getGoModCachePath();
            const formattedResults = results.map(result => {
                const location = result.location;
                const filePath = location.uri.fsPath;
                const fileName = path.basename(filePath);
                const lineNumber = location.range.start.line + 1;
                
                // 简化文件路径，去掉 Go 模块缓存路径前缀
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
    
             // 生成Webview HTML内容
    private _getHtmlForWebview(webview: vscode.Webview): string {
        return getWebviewContent(lastSearchText);
    }
}

// 搜索结果树视图提供程序
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
            // 如果有父元素，返回其子元素（目前没有层级结构，所以返回空数组）
            return Promise.resolve([]);
        }

        // 返回根级别的项目
        if (lastSearchResults.length === 0) {
            // 如果没有搜索结果，显示一个提示信息
            const noResultsItem = new SearchResultItem(
                "点击此处开始搜索",
                vscode.TreeItemCollapsibleState.None,
                undefined,
                {
                    command: 'golang-search.searchInDeps',
                    title: '开始搜索'
                }
            );
            noResultsItem.iconPath = new vscode.ThemeIcon('search');
            return Promise.resolve([noResultsItem]);
        }

        // 分离工作区和依赖库结果
        const workspaceResults = lastSearchResults.filter(r => r.source === ResultSource.Workspace);
        const dependencyResults = lastSearchResults.filter(r => r.source === ResultSource.Dependency);
        
        // 创建标题项
        const items: SearchResultItem[] = [];
        
        // 添加搜索信息头
        const searchInfoItem = new SearchResultItem(
            `搜索: "${lastSearchText}" (${lastSearchResults.length}个结果)`,
            vscode.TreeItemCollapsibleState.Expanded,
            undefined,
            {
                command: 'golang-search.searchInDeps',
                title: '重新搜索'
            }
        );
        searchInfoItem.contextValue = 'searchInfo';
        items.push(searchInfoItem);
        
        // 添加工作区结果
        if (workspaceResults.length > 0) {
            const workspaceHeader = new SearchResultItem(
                `工作区 (${workspaceResults.length})`,
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
                        title: '打开文件',
                        arguments: [result.location]
                    }
                );
                item.resourceUri = result.location.uri;
                item.contextValue = 'searchResult';
                items.push(item);
            });
        }
        
        // 添加依赖库结果
        if (dependencyResults.length > 0) {
            const depHeader = new SearchResultItem(
                `依赖库 (${dependencyResults.length})`,
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
                        title: '打开文件',
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

// 搜索结果树项目
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

// 搜索工作区项目中的内容
async function searchInWorkspace(workspaceDir: string, searchText: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    
    try {
        // 首先检查目录是否存在
        if (!fs.existsSync(workspaceDir)) {
            console.log('工作区目录不存在:', workspaceDir);
            return results;
        }
        
        // 检查目录中是否有 .go 文件
        try {
            // 使用 find 命令检查是否有 Go 文件存在
            const checkCommand = `find "${workspaceDir}" -name "*.go" -type f -print -quit`;
            const { stdout: checkResult } = await execPromise(checkCommand);
            
            if (!checkResult.trim()) {
                console.log('工作区没有Go文件:', workspaceDir);
                return results;
            }
        } catch (checkError) {
            console.log('检查Go文件失败:', checkError);
            // 继续尝试搜索，即使检查失败
        }
        
        // 在工作区目录中执行grep命令
        try {
            const grepCommand = `grep -rn "${searchText}" --include="*.go" "${workspaceDir}"`;
            
            const { stdout } = await execPromise(grepCommand);
            if (!stdout.trim()) {
                // 没有搜索结果
                return results;
            }
            
            const lines = stdout.split('\n').filter(Boolean);
            const nonTestResults: SearchResult[] = [];
            const testResults: SearchResult[] = [];
            
            for (const line of lines) {
                // 尝试匹配带行号的格式: 文件路径:行号:内容
                const match = line.match(/^(.+):(\d+):(.*)/);
                if (match) {
                    const [, filePath, lineStr, content] = match;
                    const lineNumber = parseInt(lineStr, 10) - 1; // VSCode行号从0开始
                    const uri = vscode.Uri.file(filePath);
                    const position = new vscode.Position(lineNumber, 0);
                    const range = new vscode.Range(position, position);
                    
                    // 创建一个包含位置、内容和来源的对象
                    const locationWithContent = {
                        location: new vscode.Location(uri, range),
                        content: content.trim(),
                        source: ResultSource.Workspace // 标记为工作区来源
                    };
                    
                    // 检查文件是否是测试文件 (以 _test.go 结尾)
                    if (filePath.endsWith('_test.go')) {
                        testResults.push(locationWithContent);
                    } else {
                        nonTestResults.push(locationWithContent);
                    }
                    
                    // 如果结果总数已经超过50个，则停止添加
                    if (nonTestResults.length + testResults.length >= 50) {
                        break;
                    }
                }
            }
            
            // 先添加非测试文件结果，再添加测试文件结果
            results.push(...nonTestResults, ...testResults);
            // 限制结果数量为50
            return results.slice(0, 50);
            
        } catch (grepError) {
            // grep没有结果时可能会返回错误，这是正常的
            console.log('grep搜索结果为空或出错:', grepError);
            // 出错时返回空结果
            return results;
        }
    } catch (error) {
        console.log('工作区搜索整体失败:', error);
    }
    
    return results;
}

// 搜索依赖库中的内容
async function searchInDependencies(workspaceDir: string, searchText: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const nonTestResults: SearchResult[] = [];
    const testResults: SearchResult[] = [];
    
    try {
        const goModCachePath = await getGoModCachePath();
        if (!goModCachePath || !fs.existsSync(goModCachePath)) {
            console.log('Go模块缓存路径不存在:', goModCachePath);
            return results;
        }
        
        const dependencies = await getProjectDependencies(workspaceDir);
        if (dependencies.length === 0) {
            console.log('项目没有依赖模块');
            return results;
        }
        
        // 遍历所有依赖
        for (const dep of dependencies) {
            const [moduleName, version] = dep.split(' ');
            if (!version) continue;
            
            // 构建模块在缓存中的路径
            const modulePath = path.join(goModCachePath, `${moduleName}@${version}`);
            if (fs.existsSync(modulePath)) {
                // 使用go工具搜索依赖中的关键字
                try {
                    // 在模块目录中执行grep命令 - 使用双引号包裹路径，避免空格和特殊字符问题
                    const grepCommand = `grep -rn "${searchText}" --include="*.go" "${modulePath}"`;
                    
                    const { stdout } = await execPromise(grepCommand);
                    if (!stdout.trim()) {
                        // 没有搜索结果
                        continue;
                    }
                    
                    const topLines = stdout.split('\n').filter(Boolean);
                    for (const line of topLines) {
                        
                        // 尝试匹配带行号的格式: 文件路径:行号:内容
                        const match = line.match(/^(.+):(\d+):(.*)/);
                        if (match) {
                            const [, filePath, lineStr, content] = match;
                            const lineNumber = parseInt(lineStr, 10) - 1; // VSCode行号从0开始
                            const uri = vscode.Uri.file(filePath);
                            const position = new vscode.Position(lineNumber, 0);
                            const range = new vscode.Range(position, position);
                            
                            // 创建一个包含位置、内容和来源的对象
                            const locationWithContent = {
                                location: new vscode.Location(uri, range),
                                content: content.trim(),
                                source: ResultSource.Dependency // 标记为依赖库来源
                            };
                            
                            // 检查文件是否是测试文件 (以 _test.go 结尾)
                            if (filePath.endsWith('_test.go')) {
                                testResults.push(locationWithContent);
                            } else {
                                nonTestResults.push(locationWithContent);
                            }
                            
                            // 如果结果总数已经达到了50个，则停止添加
                            if (nonTestResults.length + testResults.length >= 50) {
                                // 优先返回非测试文件
                                results.push(...nonTestResults, ...testResults);
                                return results.slice(0, 50); 
                            }
                        }
                    }
                } catch (error) {
                    // grep没有结果时会返回错误，这是正常的
                    // console.log(`模块 ${moduleName} 中没有找到匹配项:`, error);
                }
            } else {
                // 模块路径不存在，跳过
                // console.log(`模块路径不存在: ${modulePath}`);
            }
        }
        
        // 优先返回非测试文件的结果
        results.push(...nonTestResults, ...testResults);
        return results.slice(0, 50);
        
    } catch (error) {
        console.error('搜索依赖库失败:', error);
    }
    
    return results;
}

export function activate(context: vscode.ExtensionContext) {
    // 确保上下文变量初始化，即使没有搜索结果
    vscode.commands.executeCommand('setContext', 'golang-search.hasResults', false);
    
    // 创建树视图提供者（用于兼容性保留）
    const searchResultsProvider = new GoSearchResultsProvider();
    
    // 创建Webview视图提供者
    const webviewProvider = new GoSearchWebviewProvider(context.extensionUri, searchResultsProvider);
    
    // 注册Webview视图
    const searchResultsWebview = vscode.window.registerWebviewViewProvider(
        GoSearchWebviewProvider.viewType,
        webviewProvider,
        {
            webviewOptions: {
                retainContextWhenHidden: true,  // 保留Webview状态，提高用户体验
            }
        }
    );
    
    // 注册命令: 打开文件
    const openFileCommand = vscode.commands.registerCommand('golang-search.openFile', async (location: vscode.Location) => {
        try {
            if (!location || !location.uri) {
                vscode.window.showErrorMessage('无效的文件位置');
                return;
            }
            
            const document = await vscode.workspace.openTextDocument(location.uri);
            const editor = await vscode.window.showTextDocument(document);
            
            // 跳转到对应行
            const range = location.range;
            editor.selection = new vscode.Selection(range.start, range.start);
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        } catch (error) {
            vscode.window.showErrorMessage(`无法打开文件: ${error}`);
        }
    });
    
    // 注册命令: 刷新视图
    const refreshViewCommand = vscode.commands.registerCommand('golang-search.refreshView', () => {
        searchResultsProvider.refresh();
    });
    
    // 注册命令: 清除搜索结果
    const clearResultsCommand = vscode.commands.registerCommand('golang-search.clearResults', () => {
        lastSearchResults = [];
        lastSearchText = '';
        searchResultsProvider.refresh();
        vscode.commands.executeCommand('setContext', 'golang-search.hasResults', false);
    });
    
    // 添加命令和视图到上下文
    context.subscriptions.push(
        openFileCommand,
        refreshViewCommand,
        clearResultsCommand,
        searchResultsWebview
    );
    
    // 注册搜索命令
    const searchCommand = vscode.commands.registerCommand('golang-search.searchInDeps', async () => {
        // 获取当前工作空间
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('请先打开一个Go项目工作空间');
            return;
        }
        
        // 检查是否是Go项目（存在go.mod文件）
        const workspaceDir = workspaceFolders[0].uri.fsPath;
        const goModPath = path.join(workspaceDir, 'go.mod');
        
        if (!fs.existsSync(goModPath)) {
            vscode.window.showErrorMessage('当前工作空间不是有效的Go模块项目');
            return;
        }
        
        // 创建QuickPick用于实时搜索
        const quickPick = vscode.window.createQuickPick();
        quickPick.placeholder = '在Go依赖库中搜索';
        quickPick.title = '输入关键字进行实时搜索';
        quickPick.busy = false;
        quickPick.canSelectMany = false;
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        
        // 添加防抖函数，避免频繁搜索
        let debounceTimeout: NodeJS.Timeout | null = null;
        
        // 监听输入变化
        quickPick.onDidChangeValue((value) => {
            console.log('输入变化:', value);
            
            if (value.length < 3) {
                quickPick.items = [];
                quickPick.busy = false;
                return; // 至少3个字符才开始搜索
            }
            
            // 设置忙碌状态
            quickPick.busy = true;
            
            // 取消之前的延迟执行
            if (debounceTimeout) {
                clearTimeout(debounceTimeout);
            }
            
            // 设置延迟执行的搜索（300ms防抖）
            debounceTimeout = setTimeout(async () => {
                try {            
                    // 同时搜索工作区和依赖库
                    const [workspaceResults, dependencyResults] = await Promise.all([
                        searchInWorkspace(workspaceDir, value),
                        searchInDependencies(workspaceDir, value)
                    ]);
                    
                    // 对每个结果集单独排序，非测试文件优先
                    const sortWorkspaceResults = (a: SearchResult, b: SearchResult) => {
                        const aIsTest = a.location.uri.fsPath.endsWith('_test.go');
                        const bIsTest = b.location.uri.fsPath.endsWith('_test.go');
                        if (aIsTest && !bIsTest) return 1;
                        if (!aIsTest && bIsTest) return -1;
                        return 0;
                    };
                    
                    // 确保结果集内部也是按照非测试文件优先排序
                    const sortedWorkspaceResults = [...workspaceResults].sort(sortWorkspaceResults);
                    const sortedDependencyResults = [...dependencyResults].sort(sortWorkspaceResults);
                    
                    // 优先显示工作区结果，然后是依赖库结果，每个分组中非测试文件优先
                    const topResults = [...sortedWorkspaceResults, ...sortedDependencyResults];
                    
                    // 保存搜索结果以供侧边栏显示
                    lastSearchResults = [...workspaceResults, ...dependencyResults];
                    lastSearchText = value;
                    
                    // 更新侧边栏视图
                    vscode.commands.executeCommand('setContext', 'golang-search.hasResults', true);
                    searchResultsProvider.refresh();
                    
                    // 获取 Go 模块缓存路径用于简化文件路径
                    const goModCachePath = await getGoModCachePath();
                    const prefixToRemove = goModCachePath + '/';
                    
                    // 转换为QuickPickItem格式
                    const items = topResults.map(result => {
                        const location = result.location;
                        const filePath = location.uri.fsPath;
                        const fileName = path.basename(filePath);
                        
                        // 简化文件路径，去掉 Go 模块缓存路径前缀
                        let simplifiedPath = filePath;
                        if (result.source === ResultSource.Dependency && simplifiedPath.startsWith(prefixToRemove)) {
                            simplifiedPath = simplifiedPath.substring(prefixToRemove.length);
                        }
                        
                        // 为依赖库搜索结果添加深黄色背景
                        const item: vscode.QuickPickItem = {
                            label: result.content,
                            description: `${fileName}:${location.range.start.line + 1}`,
                            detail: simplifiedPath,
                        };
                        
                        // 添加自定义字段
                        (item as any).location = location;
                        
                        // 为依赖库结果设置样式
                        if (result.source === ResultSource.Dependency) {
                            // 添加多个颜色指示符号到label前面
                            item.label = `[library] $(symbol-color) $(debug-stackframe-dot) ${result.content}`;
                            
                            // 添加明显的黄色标记
                            item.description = `$(symbol-color) ${item.description}`;
                            
                            // 添加额外的颜色提示到detail前面
                            item.detail = `$(debug-breakpoint-function-unverified) ${item.detail}`;
                            
                            // 设置图标按钮
                            (item as any).buttons = [{ 
                                iconPath: new vscode.ThemeIcon('library'),
                                tooltip: '依赖库结果'
                            }];
                        }
                        
                        return item;
                    });
                    
                    // 使用 alwaysShow 属性确保工作区结果始终在前面
                    const workspaceItems = items.filter((item: any) => 
                        item.location && !(item.label.startsWith('[library]'))
                    ).map(item => {
                        // 设置 alwaysShow = true 让工作区结果始终显示在前面
                        return {
                            ...item,
                            alwaysShow: true,
                            // 添加特殊标记表明这是工作区结果
                            label: `${item.label}`
                        };
                    });
                    
                    const dependencyItems = items.filter((item: any) => 
                        item.location && item.label.startsWith('[library]')
                    );
                    
                    // 重新组合结果
                    const sortedItems = [...workspaceItems, ...dependencyItems];
                    
                    // 更新搜索结果
                    quickPick.items = sortedItems;        
                    
                    if (sortedItems.length === 0) {
                        quickPick.items = [{ label: `没有找到匹配 "${value}" 的结果` }];
                    }
                    
                } catch (error) {
                    console.error('实时搜索错误:', error);
                    quickPick.items = [{ label: `搜索错误: ${error}` }];
                } finally {
                    quickPick.busy = false;
                }
            }, 300);
        });
        
        // 监听选择变化（单击直接打开文件）
        quickPick.onDidChangeSelection(async (items) => {
            const selected = items[0] as any;
            if (selected && selected.location) {
                try {
                    // 检查文件是否存在和路径是否有效
                    const filePath = selected.location.uri.fsPath;
                    if (!filePath || !fs.existsSync(filePath)) {
                        console.log('文件不存在或路径无效:', filePath);
                        vscode.window.showErrorMessage(`文件不存在或无法访问: ${path.basename(filePath || '')}`);
                        return;
                    }
                    
                    // 检查文件类型和打开文件
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile()) {
                        console.log('路径不是有效的文件:', filePath);
                        vscode.window.showErrorMessage(`路径不是有效的文件: ${path.basename(filePath)}`);
                        return;
                    }
                    
                    // 打开选中的文件
                    const document = await vscode.workspace.openTextDocument(selected.location.uri);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    // 跳转到对应行
                    const range = selected.location.range;
                    editor.selection = new vscode.Selection(range.start, range.start);
                    editor.revealRange(range);
                    
                    // 关闭QuickPick
                    quickPick.dispose();
                } catch (error) {
                    console.error('打开文件失败:', error);
                    vscode.window.showErrorMessage(`无法打开文件: ${error}`);
                }
            }
        });
        
        // 处理双击（确认选择）
        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0] as any;
            if (selected && selected.location) {
                try {
                    // 检查文件是否存在和路径是否有效
                    const filePath = selected.location.uri.fsPath;
                    if (!filePath || !fs.existsSync(filePath)) {
                        console.log('文件不存在或路径无效:', filePath);
                        vscode.window.showErrorMessage(`文件不存在或无法访问: ${path.basename(filePath || '')}`);
                        return;
                    }
                    
                    // 检查文件类型和打开文件
                    const stats = fs.statSync(filePath);
                    if (!stats.isFile()) {
                        console.log('路径不是有效的文件:', filePath);
                        vscode.window.showErrorMessage(`路径不是有效的文件: ${path.basename(filePath)}`);
                        return;
                    }
                    
                    // 打开选中的文件
                    const document = await vscode.workspace.openTextDocument(selected.location.uri);
                    const editor = await vscode.window.showTextDocument(document);
                    
                    // 跳转到对应行
                    const range = selected.location.range;
                    editor.selection = new vscode.Selection(range.start, range.start);
                    editor.revealRange(range);
                    
                    // 关闭QuickPick
                    quickPick.dispose();
                } catch (error) {
                    console.error('打开文件失败:', error);
                    vscode.window.showErrorMessage(`无法打开文件: ${error}`);
                }
            }
        });
        
        // 设置初始 items
        quickPick.items = [
            {
                label: '请输入搜索关键字...',
                description: '至少输入3个字符开始搜索',
                detail: ''
            }
        ];
        quickPick.show();
    });
    
    context.subscriptions.push(searchCommand);
    
    // 主动刷新一次树视图
    searchResultsProvider.refresh();
    
    // 确保视图可见
    vscode.commands.executeCommand('workbench.view.extension.golang-search');
}



export function deactivate() {} 