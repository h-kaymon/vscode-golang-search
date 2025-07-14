import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as util from 'util';

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

// 搜索依赖库中的内容
async function searchInDependencies(workspaceDir: string, searchText: string): Promise<vscode.Location[]> {
    const results: vscode.Location[] = [];
    
    try {
        const goModCachePath = await getGoModCachePath();
        const dependencies = await getProjectDependencies(workspaceDir);
        
        // 遍历所有依赖
        for (const dep of dependencies) {
            const [moduleName, version] = dep.split('@');
            if (!version) continue;
            
            // 构建模块在缓存中的路径
            const modulePath = path.join(goModCachePath, `${moduleName}@${version}`);
            
            if (fs.existsSync(modulePath)) {
                // 使用go工具搜索依赖中的关键字
                try {
                    // 在模块目录中执行grep命令
                    const grepCommand = `grep -r "${searchText}" --include="*.go" ${modulePath}`;
                    const { stdout } = await execPromise(grepCommand);
                    
                    // 解析grep输出并创建位置信息
                    const lines = stdout.split('\n').filter(Boolean);
                    for (const line of lines) {
                        // grep输出格式: 文件路径:行号:内容
                        const match = line.match(/^(.+):(\d+):(.*)/);
                        if (match) {
                            const [, filePath, lineStr, _] = match;
                            const lineNumber = parseInt(lineStr, 10) - 1; // VSCode行号从0开始
                            
                            const uri = vscode.Uri.file(filePath);
                            const position = new vscode.Position(lineNumber, 0);
                            const range = new vscode.Range(position, position);
                            
                            results.push(new vscode.Location(uri, range));
                        }
                    }
                } catch (error) {
                    // grep没有结果时会返回错误，这是正常的
                    console.log(`模块 ${moduleName} 中没有找到匹配项`);
                }
            }
        }
    } catch (error) {
        console.error('搜索依赖库失败:', error);
    }
    
    return results;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Golang库搜索插件已激活');
    
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
        
        // 添加防抖函数，避免频繁搜索
        let debounceTimeout: NodeJS.Timeout | null = null;
        
        // 监听输入变化
        quickPick.onDidChangeValue(async (value) => {
            if (value.length < 3) {
                quickPick.items = [];
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
                    // 执行搜索
                    const locations = await searchInDependencies(workspaceDir, value);
                    
                    // 只取前20条结果
                    const topResults = locations.slice(0, 20);
                    
                    // 转换为QuickPickItem格式
                    const items = topResults.map(location => {
                        const filePath = location.uri.fsPath;
                        const fileName = path.basename(filePath);
                        const dirName = path.dirname(filePath);
                        
                        return {
                            label: `$(code) ${fileName}:${location.range.start.line + 1}`,
                            description: dirName,
                            detail: filePath,
                            location: location
                        };
                    });
                    
                    // 更新搜索结果
                    quickPick.items = items;
                    
                    if (items.length === 0) {
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
        
        // 处理选择项
        quickPick.onDidAccept(async () => {
            const selected = quickPick.selectedItems[0] as any;
            if (selected && selected.location) {
                // 打开选中的文件
                const document = await vscode.workspace.openTextDocument(selected.location.uri);
                const editor = await vscode.window.showTextDocument(document);
                
                // 跳转到对应行
                const range = selected.location.range;
                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range);
                
                // 关闭QuickPick
                quickPick.dispose();
            }
        });
        
        // 显示QuickPick
        quickPick.show();
    });
    
    context.subscriptions.push(searchCommand);
}

// 搜索结果的树形数据提供者
class GoDepSearchProvider implements vscode.TreeDataProvider<vscode.Location> {
    private _onDidChangeTreeData = new vscode.EventEmitter<vscode.Location | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    
    constructor(private locations: vscode.Location[]) {}
    
    getTreeItem(element: vscode.Location): vscode.TreeItem {
        const filePath = element.uri.fsPath;
        const fileName = path.basename(filePath);
        const dirName = path.dirname(filePath);
        
        const item = new vscode.TreeItem(`${fileName}:${element.range.start.line + 1}`);
        item.description = dirName;
        item.tooltip = filePath;
        item.command = {
            command: 'vscode.open',
            arguments: [
                element.uri,
                {
                    selection: element.range
                }
            ],
            title: '打开文件'
        };
        
        return item;
    }
    
    getChildren(element?: vscode.Location): vscode.Location[] | Promise<vscode.Location[]> {
        if (element) {
            return []; // 叶子节点，没有子元素
        }
        
        return this.locations;
    }
}

export function deactivate() {} 