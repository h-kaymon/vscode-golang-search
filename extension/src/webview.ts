// Generate webview HTML content
export function getWebviewContent(): string {
    // Move script content to a separate variable to avoid escaping issues
    const scriptContent = `
        const vscode = acquireVsCodeApi();
        const searchInput = document.getElementById('searchInput');
        const resultsContainer = document.getElementById('results');
        const loadingDiv = document.getElementById('loading');
        const errorDiv = document.getElementById('error');
        
        let searchTimeout;
        let currentSearchText = '';
        
        // Handle search input
        searchInput.addEventListener('input', (e) => {
            const value = e.target.value.trim();
            
            if (value.length < 2) {
                resultsContainer.innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M21 8C13.268 8 7 14.268 7 22C7 29.732 13.268 36 21 36C24.752 36 28.116 34.46 30.504 31.896L38.304 39.696C38.5 39.892 38.756 40 39.024 40C39.292 40 39.548 39.892 39.744 39.696C40.136 39.304 40.136 38.668 39.744 38.276L31.944 30.476C34.476 28.084 36 24.748 36 21C36 13.268 29.732 7 22 7L21 8ZM21 10C28.168 10 34 15.832 34 23C34 30.168 28.168 36 21 36C13.832 36 8 30.168 8 23C8 15.832 13.832 10 21 10Z" fill="currentColor" opacity="0.5"/></svg><div>Enter at least 2 characters to search</div></div>';
                return;
            }
            
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                currentSearchText = value;
                vscode.postMessage({
                    type: 'search',
                    value: value
                });
            }, 300);
        });
        
        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            
            switch (message.type) {
                case 'searchStart':
                    loadingDiv.classList.add('active');
                    errorDiv.style.display = 'none';
                    resultsContainer.innerHTML = '';
                    break;
                    
                case 'searchResults':
                    loadingDiv.classList.remove('active');
                    displayResults(message.results, message.searchText);
                    break;
                    
                case 'searchError':
                    loadingDiv.classList.remove('active');
                    errorDiv.style.display = 'block';
                    errorDiv.textContent = message.error;
                    resultsContainer.innerHTML = '';
                    break;
            }
        });
        
        function displayResults(results, searchText) {
            if (!results || results.length === 0) {
                resultsContainer.innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M24 12C18.48 12 14 16.48 14 22C14 27.52 18.48 32 24 32C29.52 32 34 27.52 34 22C34 16.48 29.52 12 24 12ZM24 30C19.58 30 16 26.42 16 22C16 17.58 19.58 14 24 14C28.42 14 32 17.58 32 22C32 26.42 28.42 30 24 30Z" fill="currentColor" opacity="0.5"/><path d="M22 18H26V23H22V18Z" fill="currentColor" opacity="0.5"/><path d="M22 25H26V27H22V25Z" fill="currentColor" opacity="0.5"/></svg><div>No results found for "' + searchText + '"</div></div>';
                return;
            }
            
            // Group results
            const workspaceResults = results.filter(r => !r.isDependency && !r.isStdlib);
            const dependencyResults = results.filter(r => r.isDependency);
            const stdlibResults = results.filter(r => r.isStdlib);
            
            let html = '';
            
            // Workspace results
            if (workspaceResults.length > 0) {
                html += '<div class="result-group"><div class="result-group-header"><span>🏠 Workspace</span><span style="opacity: 0.7; font-size: 12px;">(' + workspaceResults.length + ')</span></div>';
                workspaceResults.forEach(r => {
                    html += createResultItem(r, searchText);
                });
                html += '</div>';
            }
            
            // Dependency results
            if (dependencyResults.length > 0) {
                html += '<div class="result-group"><div class="result-group-header"><span>📦 Dependencies</span><span style="opacity: 0.7; font-size: 12px;">(' + dependencyResults.length + ')</span></div>';
                dependencyResults.forEach(r => {
                    html += createResultItem(r, searchText);
                });
                html += '</div>';
            }
            
            // Standard library results
            if (stdlibResults.length > 0) {
                html += '<div class="result-group"><div class="result-group-header"><span>⚡ Go Standard Library</span><span style="opacity: 0.7; font-size: 12px;">(' + stdlibResults.length + ')</span></div>';
                stdlibResults.forEach(r => {
                    html += createResultItem(r, searchText);
                });
                html += '</div>';
            }
            
            resultsContainer.innerHTML = html;
        }
        
        function createResultItem(result, searchText) {
            const fileName = result.uri.split('/').pop();
            const highlightedContent = highlightText(result.content, searchText);
            
            const tags = [];
            if (result.isTest) tags.push('<span class="tag test">Test</span>');
            if (result.isDependency) tags.push('<span class="tag dependency">Dependency</span>');
            if (result.isStdlib) tags.push('<span class="tag stdlib">Stdlib</span>');
            
            return '<div class="result-item" onclick="openFile(\\'' + result.uri.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'") + '\\', ' + result.line + ')"><div class="result-content">' + highlightedContent + '</div><div class="result-location"><span class="result-file">' + fileName + ':' + (result.line + 1) + '</span>' + tags.join(' ') + '<span class="result-path" title="' + result.uri + '">' + result.uri + '</span></div></div>';
        }
        
        function highlightText(text, searchText) {
            if (!searchText) return escapeHtml(text);
            
            const safeText = escapeHtml(text);
            const safeSearch = escapeHtml(searchText);
            
            // Simple case-insensitive replace without regex
            let result = safeText;
            const lowerText = safeText.toLowerCase();
            const lowerSearch = safeSearch.toLowerCase();
            
            let index = 0;
            let highlightedText = '';
            
            while (index < lowerText.length) {
                const foundIndex = lowerText.indexOf(lowerSearch, index);
                if (foundIndex === -1) {
                    highlightedText += safeText.substring(index);
                    break;
                }
                
                highlightedText += safeText.substring(index, foundIndex);
                highlightedText += '<span class="highlight">' + safeText.substring(foundIndex, foundIndex + safeSearch.length) + '</span>';
                index = foundIndex + safeSearch.length;
            }
            
            return highlightedText;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function openFile(uri, line) {
            vscode.postMessage({
                type: 'openFile',
                uri: uri,
                line: line
            });
        }
        
        // Focus on search input
        searchInput.focus();
    `;
    
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Golang Search</title>
        <style>
            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                color: var(--vscode-foreground);
                background-color: var(--vscode-editor-background);
                margin: 0;
                padding: 0;
                overflow: hidden;
            }
            
            .container {
                display: flex;
                flex-direction: column;
                height: 100vh;
                padding: 10px;
                box-sizing: border-box;
            }
            
            .search-container {
                padding: 10px 0;
            }
            
            #searchInput {
                width: 100%;
                padding: 8px 12px;
                background-color: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                border-radius: 4px;
                outline: none;
                font-size: 14px;
                box-sizing: border-box;
            }
            
            #searchInput:focus {
                border-color: var(--vscode-focusBorder);
            }
            
            .results-container {
                flex: 1;
                overflow-y: auto;
                padding: 10px 0;
            }
            
            .result-group {
                margin-bottom: 20px;
            }
            
            .result-group-header {
                font-weight: bold;
                margin-bottom: 8px;
                padding: 4px 8px;
                background-color: var(--vscode-editor-lineHighlightBackground);
                border-radius: 4px;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .result-item {
                padding: 6px 12px;
                cursor: pointer;
                border-radius: 4px;
                margin-bottom: 4px;
                display: flex;
                flex-direction: column;
                gap: 4px;
                transition: background-color 0.1s;
            }
            
            .result-item:hover {
                background-color: var(--vscode-list-hoverBackground);
            }
            
            .result-content {
                font-family: 'Courier New', monospace;
                font-size: 13px;
                white-space: pre-wrap;
                word-break: break-all;
                color: var(--vscode-editor-foreground);
            }
            
            .result-location {
                font-size: 12px;
                color: var(--vscode-descriptionForeground);
                display: flex;
                gap: 8px;
                align-items: center;
            }
            
            .result-file {
                font-weight: 500;
            }
            
            .result-path {
                opacity: 0.8;
                font-size: 11px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            
            .empty-state {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100%;
                color: var(--vscode-descriptionForeground);
                text-align: center;
                gap: 10px;
            }
            
            .loading {
                display: none;
                text-align: center;
                padding: 20px;
                color: var(--vscode-descriptionForeground);
            }
            
            .loading.active {
                display: block;
            }
            
            .error {
                color: var(--vscode-errorForeground);
                padding: 10px;
                text-align: center;
            }
            
            .highlight {
                background-color: var(--vscode-editor-findMatchHighlightBackground);
                color: var(--vscode-editor-findMatchHighlightForeground);
                border-radius: 2px;
                padding: 1px 2px;
            }
            
            .tag {
                font-size: 11px;
                padding: 2px 6px;
                border-radius: 3px;
                background-color: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
            }
            
            .tag.test {
                background-color: var(--vscode-testing-iconQueued);
                color: var(--vscode-editor-background);
            }
            
            .tag.dependency {
                background-color: var(--vscode-gitDecoration-modifiedResourceForeground);
                color: var(--vscode-editor-background);
            }
            
            .tag.stdlib {
                background-color: var(--vscode-gitDecoration-addedResourceForeground);
                color: var(--vscode-editor-background);
            }
            
            .icon {
                width: 16px;
                height: 16px;
                display: inline-block;
                vertical-align: middle;
            }
            
            ::-webkit-scrollbar {
                width: 10px;
            }
            
            ::-webkit-scrollbar-track {
                background: transparent;
            }
            
            ::-webkit-scrollbar-thumb {
                background: var(--vscode-scrollbarSlider-background);
                border-radius: 5px;
            }
            
            ::-webkit-scrollbar-thumb:hover {
                background: var(--vscode-scrollbarSlider-hoverBackground);
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="search-container">
                <input type="text" id="searchInput" placeholder="Search in Go files and dependencies (min 2 characters)..." />
            </div>
            <div class="loading" id="loading">Searching...</div>
            <div class="error" id="error" style="display: none;"></div>
            <div class="results-container" id="results">
                <div class="empty-state">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M21 8C13.268 8 7 14.268 7 22C7 29.732 13.268 36 21 36C24.752 36 28.116 34.46 30.504 31.896L38.304 39.696C38.5 39.892 38.756 40 39.024 40C39.292 40 39.548 39.892 39.744 39.696C40.136 39.304 40.136 38.668 39.744 38.276L31.944 30.476C34.476 28.084 36 24.748 36 21C36 13.268 29.732 7 22 7L21 8ZM21 10C28.168 10 34 15.832 34 23C34 30.168 28.168 36 21 36C13.832 36 8 30.168 8 23C8 15.832 13.832 10 21 10Z" fill="currentColor" opacity="0.5"/>
                    </svg>
                    <div>Enter a search term to begin</div>
                    <div style="font-size: 12px; opacity: 0.7;">Search in workspace and Go dependencies</div>
                </div>
            </div>
        </div>
        
        <script>${scriptContent}</script>
    </body>
    </html>`;
} 