// 生成webview的HTML内容
export function getWebviewContent(searchText?: string) {
    return /*html*/`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Go 代码搜索</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            padding: 0;
            margin: 0;
        }
        .search-container {
            padding: 8px;
            position: sticky;
            top: 0;
            background-color: var(--vscode-editor-background);
            z-index: 10;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        #search-input {
            width: 100%;
            padding: 6px;
            box-sizing: border-box;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
        }
        .results-container {
            margin-top: 8px;
        }
        .result-group {
            margin-bottom: 16px;
        }
        .result-group-header {
            font-weight: bold;
            padding: 4px 8px;
            background-color: var(--vscode-panel-border);
            margin-bottom: 4px;
        }
        .result-item {
            padding: 4px 8px;
            cursor: pointer;
            display: flex;
            flex-direction: column;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        .result-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .result-content {
            white-space: pre;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 2px;
        }
        .result-path {
            font-size: 0.85em;
            opacity: 0.8;
            display: flex;
            justify-content: space-between;
        }
        .dependency-item {
            border-left: 3px solid gold;
        }
        .test-file-item {
            border-left: 3px solid #8ba0a8; /* 灰蓝色标识测试文件 */
            opacity: 0.9;
        }
        .highlight {
            background-color: #FFFF00;
            color: #000000;
            font-weight: bold;
            border-radius: 2px;
            padding: 0 2px;
        }
        body.vscode-dark .highlight {
            background-color: #FFA500;
        }
        .loading {
            padding: 8px;
            font-style: italic;
            color: var(--vscode-descriptionForeground);
        }
        .error {
            padding: 8px;
            color: var(--vscode-errorForeground);
        }
        .no-results {
            padding: 8px;
            color: var(--vscode-descriptionForeground);
        }
        .tips {
            padding: 8px;
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="search-container">
        <input type="text" id="search-input" placeholder="搜索Go代码 (至少输入3个字符)" value="${searchText || ''}" />
    </div>
    
    <div id="search-status" class="tips">
        输入关键词开始搜索 Go 代码...
    </div>
    
    <div id="results-container" class="results-container"></div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('search-input');
        const resultsContainer = document.getElementById('results-container');
        const searchStatus = document.getElementById('search-status');
        
        // 高亮关键词函数
        function highlightText(text, keyword) {
            if (!keyword || keyword.length < 2) return text;
            
            // 转义正则表达式特殊字符
            function escapeRegExp(string) {
                return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            }
            
            const escapedKeyword = escapeRegExp(keyword);
            const regex = new RegExp(escapedKeyword, 'gi');
            
            return text.replace(regex, function(match) {
                return '<span class="highlight">' + match + '</span>';
            });
        }
        
        // 防抖函数
        function debounce(func, wait) {
            let timeout;
            return function(...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        }
        
        // 处理搜索输入
        const handleSearch = debounce((text) => {
            if (text.length >= 3) {
                searchStatus.textContent = '搜索中...';
                searchStatus.className = 'loading';
                vscode.postMessage({
                    command: 'search',
                    text: text
                });
            } else if (text.length > 0) {
                searchStatus.textContent = '请至少输入3个字符...';
                searchStatus.className = 'tips';
                resultsContainer.innerHTML = '';
            } else {
                searchStatus.textContent = '输入关键词开始搜索 Go 代码...';
                searchStatus.className = 'tips';
                resultsContainer.innerHTML = '';
            }
        }, 300);
        
        // 监听输入变化
        searchInput.addEventListener('input', (e) => {
            handleSearch(e.target.value);
        });
        
        // 处理文件点击
        function handleFileOpen(filePath, line, column = 0) {
            vscode.postMessage({
                command: 'openFile',
                filePath: filePath,
                line: line - 1, // 转换为0-based
                column: column
            });
        }
        
        // 监听来自扩展的消息
        window.addEventListener('message', (event) => {
            const message = event.data;
            
            switch (message.command) {
                case 'searchStarted':
                    searchStatus.textContent = '搜索中...';
                    searchStatus.className = 'loading';
                    break;
                    
                case 'searchResults':
                    if (message.results.length === 0) {
                        searchStatus.textContent = '没有找到匹配 "' + message.searchText + '" 的结果';
                        searchStatus.className = 'no-results';
                        resultsContainer.innerHTML = '';
                        return;
                    }
                    
                    // 处理搜索结果
                    searchStatus.textContent = '搜索结果: "' + message.searchText + '" (' + message.results.length + '个结果)';
                    searchStatus.className = 'result-group-header';
                    
                    // 分组结果
                    const workspaceResults = message.results.filter(r => r.source === 'workspace');
                    const dependencyResults = message.results.filter(r => r.source === 'dependency');
                    
                    // 清空结果容器
                    resultsContainer.innerHTML = '';
                    
                                            // 添加工作区结果
                    if (workspaceResults.length > 0) {
                        const workspaceGroup = document.createElement('div');
                        workspaceGroup.className = 'result-group';
                        
                        const workspaceHeader = document.createElement('div');
                        workspaceHeader.className = 'result-group-header';
                        
                        // 分析常规文件和测试文件的数量
                        const nonTestWorkspaceResults = workspaceResults.filter(r => 
                            !r.filePath.endsWith('_test.go')
                        );
                        const testWorkspaceResults = workspaceResults.filter(r => 
                            r.filePath.endsWith('_test.go')
                        );
                        
                        workspaceHeader.textContent = '工作区 (' + workspaceResults.length + 
                            ', 常规: ' + nonTestWorkspaceResults.length + 
                            ', 测试: ' + testWorkspaceResults.length + ')';
                        workspaceGroup.appendChild(workspaceHeader);
                        
                        workspaceResults.forEach(result => {
                            const resultItem = document.createElement('div');
                            const isTestFile = result.filePath.endsWith('_test.go');
                            resultItem.className = isTestFile ? 'result-item test-file-item' : 'result-item';
                            resultItem.addEventListener('click', () => {
                                handleFileOpen(result.filePath, result.lineNumber);
                            });
                            
                            const contentElem = document.createElement('div');
                            contentElem.className = 'result-content';
                            // 使用innerHTML显示高亮的文本
                            const safeContent = result.content
                                .replace(/&/g, '&amp;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;');
                            contentElem.innerHTML = highlightText(safeContent, message.searchText);
                            
                            const pathElem = document.createElement('div');
                            pathElem.className = 'result-path';
                            pathElem.innerHTML = '<span>' + result.fileName + ':' + result.lineNumber + '</span><span>' + result.simplifiedPath + '</span>';
                            
                            resultItem.appendChild(contentElem);
                            resultItem.appendChild(pathElem);
                            workspaceGroup.appendChild(resultItem);
                        });
                        
                        resultsContainer.appendChild(workspaceGroup);
                    }
                    
                    // 添加依赖库结果
                    if (dependencyResults.length > 0) {
                        const depGroup = document.createElement('div');
                        depGroup.className = 'result-group';
                        
                        const depHeader = document.createElement('div');
                        depHeader.className = 'result-group-header';
                        
                        // 分析常规文件和测试文件的数量
                        const nonTestDepResults = dependencyResults.filter(r => 
                            !r.filePath.endsWith('_test.go')
                        );
                        const testDepResults = dependencyResults.filter(r => 
                            r.filePath.endsWith('_test.go')
                        );
                        
                        depHeader.textContent = '依赖库 (' + dependencyResults.length + 
                            ', 常规: ' + nonTestDepResults.length + 
                            ', 测试: ' + testDepResults.length + ')';
                        depGroup.appendChild(depHeader);
                        
                        dependencyResults.forEach(result => {
                            const resultItem = document.createElement('div');
                            const isTestFile = result.filePath.endsWith('_test.go');
                            let className = 'result-item dependency-item';
                            if (isTestFile) {
                                className += ' test-file-item';
                            }
                            resultItem.className = className;
                            resultItem.addEventListener('click', () => {
                                handleFileOpen(result.filePath, result.lineNumber);
                            });
                            
                            const contentElem = document.createElement('div');
                            contentElem.className = 'result-content';
                            // 使用innerHTML显示高亮的文本
                            const safeContent = result.content
                                .replace(/&/g, '&amp;')
                                .replace(/</g, '&lt;')
                                .replace(/>/g, '&gt;');
                            contentElem.innerHTML = highlightText(safeContent, message.searchText);
                            
                            const pathElem = document.createElement('div');
                            pathElem.className = 'result-path';
                            pathElem.innerHTML = '<span>' + result.fileName + ':' + result.lineNumber + '</span><span>' + result.simplifiedPath + '</span>';
                            
                            resultItem.appendChild(contentElem);
                            resultItem.appendChild(pathElem);
                            depGroup.appendChild(resultItem);
                        });
                        
                        resultsContainer.appendChild(depGroup);
                    }
                    break;
                    
                case 'searchError':
                    searchStatus.textContent = message.message;
                    searchStatus.className = 'error';
                    resultsContainer.innerHTML = '';
                    break;
            }
        });
        
        // 初始焦点
        setTimeout(() => {
            searchInput.focus();
        }, 100);
        
        // 初始搜索
        if (searchInput.value && searchInput.value.length >= 3) {
            handleSearch(searchInput.value);
        }
    </script>
</body>
</html>
`;
} 