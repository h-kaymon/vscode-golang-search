// Generate webview HTML content
export function getWebviewContent(searchText?: string) {
    return /*html*/`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Go Code Search</title>
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
        .stdlib-item {
            border-left: 3px solid #00A8FF; /* Blue for Go standard library */
        }
        .test-file-item {
            border-left: 3px solid #8ba0a8; /* Grayish blue indicator for test files */
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
        <input type="text" id="search-input" placeholder="Search Go code (at least 3 characters)" value="${searchText || ''}" />
    </div>
    
    <div id="search-status" class="tips">
        Enter keywords to search Go code...
    </div>
    
    <div id="results-container" class="results-container"></div>
    
    <script>
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('search-input');
        const resultsContainer = document.getElementById('results-container');
        const searchStatus = document.getElementById('search-status');
        
        // Highlight keywords function
        function highlightText(text, keyword) {
            if (!keyword || keyword.length < 2) return text;
            
            // Escape regex special characters
            function escapeRegExp(string) {
                return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            }
            
            const escapedKeyword = escapeRegExp(keyword);
            const regex = new RegExp(escapedKeyword, 'gi');
            
            return text.replace(regex, function(match) {
                return '<span class="highlight">' + match + '</span>';
            });
        }
        
        // Debounce function
        function debounce(func, wait) {
            let timeout;
            return function(...args) {
                clearTimeout(timeout);
                timeout = setTimeout(() => func.apply(this, args), wait);
            };
        }
        
        // Handle search input
        const handleSearch = debounce((text) => {
            if (text.length >= 3) {
                searchStatus.textContent = 'Searching...';
                searchStatus.className = 'loading';
                vscode.postMessage({
                    command: 'search',
                    text: text
                });
            } else if (text.length > 0) {
                searchStatus.textContent = 'Please enter at least 3 characters...';
                searchStatus.className = 'tips';
                resultsContainer.innerHTML = '';
            } else {
                searchStatus.textContent = 'Enter keywords to search Go code...';
                searchStatus.className = 'tips';
                resultsContainer.innerHTML = '';
            }
        }, 300);
        
        // Listen for input changes
        searchInput.addEventListener('input', (e) => {
            handleSearch(e.target.value);
        });
        
        // Handle file click
        function handleFileOpen(filePath, line, column = 0) {
            vscode.postMessage({
                command: 'openFile',
                filePath: filePath,
                line: line - 1, // Convert to 0-based
                column: column
            });
        }
        
        // Listen for messages from extension
        window.addEventListener('message', (event) => {
            const message = event.data;
            
            switch (message.command) {
                case 'searchStarted':
                    searchStatus.textContent = 'Searching...';
                    searchStatus.className = 'loading';
                    break;
                    
                case 'searchResults':
                    if (message.results.length === 0) {
                        searchStatus.textContent = 'No results found for "' + message.searchText + '"';
                        searchStatus.className = 'no-results';
                        resultsContainer.innerHTML = '';
                        return;
                    }
                    
                    // Process search results
                    searchStatus.textContent = 'Search results: "' + message.searchText + '" (' + message.results.length + ' results)';
                    searchStatus.className = 'result-group-header';
                    
                    // Group results
                    const workspaceResults = message.results.filter(r => r.source === 'workspace');
                    const stdlibResults = message.results.filter(r => r.source === 'stdlib');
                    const dependencyResults = message.results.filter(r => r.source === 'dependency');
                    
                    // Clear results container
                    resultsContainer.innerHTML = '';
                    
                                            // Add workspace results
                    if (workspaceResults.length > 0) {
                        const workspaceGroup = document.createElement('div');
                        workspaceGroup.className = 'result-group';
                        
                        const workspaceHeader = document.createElement('div');
                        workspaceHeader.className = 'result-group-header';
                        
                        // Analyze regular and test file counts
                        const nonTestWorkspaceResults = workspaceResults.filter(r => 
                            !r.filePath.endsWith('_test.go')
                        );
                        const testWorkspaceResults = workspaceResults.filter(r => 
                            r.filePath.endsWith('_test.go')
                        );
                        
                        workspaceHeader.textContent = 'Workspace (' + workspaceResults.length + 
                            ', Regular: ' + nonTestWorkspaceResults.length + 
                            ', Tests: ' + testWorkspaceResults.length + ')';
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
                            // Use innerHTML to display highlighted text
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
                    
                    // Add Go standard library results
                    if (stdlibResults.length > 0) {
                        const stdlibGroup = document.createElement('div');
                        stdlibGroup.className = 'result-group';
                        
                        const stdlibHeader = document.createElement('div');
                        stdlibHeader.className = 'result-group-header';
                        
                        // Analyze regular and test file counts
                        const nonTestStdlibResults = stdlibResults.filter(r => 
                            !r.filePath.endsWith('_test.go')
                        );
                        const testStdlibResults = stdlibResults.filter(r => 
                            r.filePath.endsWith('_test.go')
                        );
                        
                        stdlibHeader.textContent = 'Go Source Code (' + stdlibResults.length + 
                            ', Regular: ' + nonTestStdlibResults.length + 
                            ', Tests: ' + testStdlibResults.length + ')';
                        stdlibGroup.appendChild(stdlibHeader);
                        
                        stdlibResults.forEach(result => {
                            const resultItem = document.createElement('div');
                            const isTestFile = result.filePath.endsWith('_test.go');
                            let className = 'result-item stdlib-item';
                            if (isTestFile) {
                                className += ' test-file-item';
                            }
                            resultItem.className = className;
                            resultItem.addEventListener('click', () => {
                                handleFileOpen(result.filePath, result.lineNumber);
                            });
                            
                            const contentElem = document.createElement('div');
                            contentElem.className = 'result-content';
                            // Use innerHTML to display highlighted text
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
                            stdlibGroup.appendChild(resultItem);
                        });
                        
                        resultsContainer.appendChild(stdlibGroup);
                    }
                    
                    // Add dependency results
                    if (dependencyResults.length > 0) {
                        const depGroup = document.createElement('div');
                        depGroup.className = 'result-group';
                        
                        const depHeader = document.createElement('div');
                        depHeader.className = 'result-group-header';
                        
                        // Analyze regular and test file counts
                        const nonTestDepResults = dependencyResults.filter(r => 
                            !r.filePath.endsWith('_test.go')
                        );
                        const testDepResults = dependencyResults.filter(r => 
                            r.filePath.endsWith('_test.go')
                        );
                        
                        depHeader.textContent = 'Third-party Dependencies (' + dependencyResults.length + 
                            ', Regular: ' + nonTestDepResults.length + 
                            ', Tests: ' + testDepResults.length + ')';
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
                            // Use innerHTML to display highlighted text
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
                    
                case 'clearInput':
                    // Clear input field and reset status
                    searchInput.value = '';
                    searchStatus.textContent = 'Enter keywords to search Go code...';
                    searchStatus.className = 'tips';
                    resultsContainer.innerHTML = '';
                    break;
            }
        });
        
        // Initial focus
        setTimeout(() => {
            searchInput.focus();
        }, 100);
        
        // Initial search
        if (searchInput.value && searchInput.value.length >= 3) {
            handleSearch(searchInput.value);
        }
    </script>
</body>
</html>
`;
} 