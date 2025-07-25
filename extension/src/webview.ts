// Generate webview HTML content
export function getWebviewContent(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Go Search</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 10px;
        }
        
        .search-container {
            margin-bottom: 15px;
        }
        
        .search-controls {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 8px;
        }
        
        #searchInput {
            flex: 1;
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border-radius: 2px;
            font-size: var(--vscode-font-size);
        }
        
        #searchInput:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        
        .fuzzy-toggle {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            user-select: none;
        }
        
        .fuzzy-toggle input[type="checkbox"] {
            margin: 0;
        }
        
        .search-mode {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 2px 6px;
            background-color: var(--vscode-badge-background);
            border-radius: 10px;
            white-space: nowrap;
        }
        
        .results-container {
            max-height: calc(100vh - 120px);
            overflow-y: auto;
        }
        
        .result-group {
            margin-bottom: 15px;
        }
        
        .result-group-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 4px 0;
            border-bottom: 1px solid var(--vscode-panel-border);
            margin-bottom: 8px;
            font-weight: bold;
            font-size: 13px;
        }
        
        .result-item {
            padding: 6px 8px;
            margin-bottom: 4px;
            border: 1px solid transparent;
            border-radius: 3px;
            cursor: pointer;
            background-color: var(--vscode-list-inactiveSelectionBackground);
        }
        
        .result-item:hover {
            background-color: var(--vscode-list-hoverBackground);
            border-color: var(--vscode-list-hoverBackground);
        }
        
        .result-item.dependency {
            border-left: 3px solid #DAA520;
        }
        
        .result-item.test {
            border-left: 3px solid #6495ED;
        }
        
        .result-item.stdlib {
            border-left: 3px solid #32CD32;
        }
        
        .result-content {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size);
            line-height: 1.3;
            margin-bottom: 4px;
            word-break: break-all;
        }
        
        .result-location {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
        }
        
        .result-file {
            color: var(--vscode-textLink-foreground);
            font-weight: bold;
        }
        
        .result-path {
            color: var(--vscode-descriptionForeground);
            text-overflow: ellipsis;
            overflow: hidden;
            white-space: nowrap;
            max-width: 200px;
        }
        
        .tag {
            padding: 1px 4px;
            border-radius: 2px;
            font-size: 10px;
            margin-left: 4px;
        }
        
        .tag.test {
            background-color: #6495ED;
            color: white;
        }
        
        .tag.dependency {
            background-color: #DAA520;
            color: white;
        }
        
        .tag.stdlib {
            background-color: #32CD32;
            color: white;
        }
        
        .highlight {
            background-color: var(--vscode-editor-findMatchHighlightBackground);
            color: var(--vscode-editor-findMatchHighlightForeground);
        }
        
        .loading, .no-results, .error {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
        }
        
        .error {
            color: var(--vscode-errorForeground);
        }
        
        .info {
            text-align: center;
            padding: 15px;
            color: var(--vscode-descriptionForeground);
            font-style: italic;
            border-radius: 4px;
            background-color: var(--vscode-inputValidation-infoBackground);
            border: 1px solid var(--vscode-inputValidation-infoBorder);
        }
        
        .info.building {
            color: var(--vscode-progressBar-background);
            background-color: var(--vscode-editor-inactiveSelectionBackground);
        }
        
        .info.warning {
            color: var(--vscode-inputValidation-warningForeground);
            background-color: var(--vscode-inputValidation-warningBackground);
            border-color: var(--vscode-inputValidation-warningBorder);
        }
        
        .index-status {
            text-align: center;
            padding: 8px 12px;
            margin-bottom: 12px;
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            border-radius: 12px;
            opacity: 0.8;
        }
    </style>
</head>
<body>
    <div class="search-container">
        <div class="search-controls">
            <input type="text" id="searchInput" placeholder="Search in Go files and dependencies (min 2 characters)..." />
            <label class="fuzzy-toggle">
                <input type="checkbox" id="fuzzyCheckbox" />
                Fuzzy
            </label>
            <span class="search-mode" id="searchMode">Exact</span>
        </div>
    </div>
    
    <div id="results" class="results-container">
        <div class="no-results">Enter search term to start searching...</div>
    </div>

    <script>
        ${getScriptContent()}
    </script>
</body>
</html>`;
}

function getScriptContent(): string {
    return `
        const vscode = acquireVsCodeApi();
        let debounceTimeout;
        let currentSearchText = '';
        let isFuzzy = false;
        
        const searchInput = document.getElementById('searchInput');
        const fuzzyCheckbox = document.getElementById('fuzzyCheckbox');
        const searchMode = document.getElementById('searchMode');
        const resultsDiv = document.getElementById('results');
        
        function updateSearchMode() {
            isFuzzy = fuzzyCheckbox.checked;
            searchMode.textContent = isFuzzy ? 'Fuzzy' : 'Exact';
            searchMode.style.backgroundColor = isFuzzy ? 'var(--vscode-button-background)' : 'var(--vscode-badge-background)';
            
            // Re-trigger search if there's current text
            if (currentSearchText.length >= 2) {
                performSearch(currentSearchText);
            }
        }
        
        function debounce(func, wait) {
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(debounceTimeout);
                    func(...args);
                };
                clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(later, wait);
            };
        }
        
        function performSearch(searchText) {
            currentSearchText = searchText;
            if (searchText.length < 2) {
                resultsDiv.innerHTML = '<div class="no-results">Enter at least 2 characters to search...</div>';
                return;
            }
            
            resultsDiv.innerHTML = '<div class="loading">Searching...</div>';
            vscode.postMessage({
                type: 'search',
                value: searchText,
                fuzzy: isFuzzy
            });
        }
        
        const debouncedSearch = debounce(performSearch, 300);
        
        searchInput.addEventListener('input', (e) => {
            debouncedSearch(e.target.value);
        });
        
        fuzzyCheckbox.addEventListener('change', updateSearchMode);
        
        function openFile(uri, line) {
            vscode.postMessage({
                type: 'openFile',
                uri: uri,
                line: line
            });
        }
        
        function highlightText(text, searchText) {
            if (!searchText) return escapeHtml(text);
            const safeText = escapeHtml(text);
            const safeSearchText = escapeHtml(searchText);
            const lowerText = safeText.toLowerCase();
            const lowerSearch = safeSearchText.toLowerCase();
            
            let result = '';
            let lastIndex = 0;
            let index = lowerText.indexOf(lowerSearch);
            
            while (index !== -1) {
                result += safeText.substring(lastIndex, index);
                result += '<span class="highlight">';
                result += safeText.substring(index, index + safeSearchText.length);
                result += '</span>';
                lastIndex = index + safeSearchText.length;
                index = lowerText.indexOf(lowerSearch, lastIndex);
            }
            
            result += safeText.substring(lastIndex);
            return result;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        function createResultItem(result, searchText) {
            const highlightedContent = highlightText(result.content, searchText);
            const tags = [];
            
            if (result.isTest) tags.push('<span class="tag test">Test</span>');
            if (result.isDependency) tags.push('<span class="tag dependency">Dependency</span>');
            if (result.isStdlib) tags.push('<span class="tag stdlib">Stdlib</span>');
            
            let cssClass = 'result-item';
            if (result.isDependency) cssClass += ' dependency';
            if (result.isTest) cssClass += ' test';
            if (result.isStdlib) cssClass += ' stdlib';
            
            return '<div class="' + cssClass + '" onclick="openFile(\\'' + result.uri.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'") + '\\', ' + result.line + ')">' +
                '<div class="result-content">' + highlightedContent + '</div>' +
                '<div class="result-location">' +
                    '<span class="result-file">' + result.uri.split('/').pop() + ':' + (result.line + 1) + '</span>' +
                    tags.join(' ') +
                    '<span class="result-path" title="' + result.uri + '">' + result.uri + '</span>' +
                '</div>' +
            '</div>';
        }
        
        function displayError(error) {
            resultsDiv.innerHTML = '<div class="error">Search error: ' + escapeHtml(error) + '</div>';
        }
        
        // Handle messages from the extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'searchStart':
                    resultsDiv.innerHTML = '<div class="loading">Searching...</div>';
                    break;
                case 'searchResults':
                    displayResults(message.results, message.searchText, message.fuzzy, message.indexStatus);
                    break;
                case 'searchInfo':
                    displayInfo(message.message, message.status);
                    break;
                case 'searchError':
                    displayError(message.error);
                    break;
            }
        });
        
        function displayInfo(message, status) {
            let className = 'info';
            let icon = '$(info)';
            
            if (status === 'building') {
                className = 'info building';
                icon = '$(loading~spin)';
            } else if (status === 'no-index') {
                className = 'info warning';
                icon = '$(warning)';
            }
            
            resultsDiv.innerHTML = '<div class="' + className + '">' + icon + ' ' + escapeHtml(message) + '</div>';
        }
        
        function displayResults(results, searchText, fuzzy, indexStatus) {
            if (results.length === 0) {
                let statusText = indexStatus ? ' (' + indexStatus + ')' : '';
                resultsDiv.innerHTML = '<div class="no-results">No results found for "' + escapeHtml(searchText) + '" (' + (fuzzy ? 'fuzzy' : 'exact') + ' search)' + statusText + '</div>';
                return;
            }
            
            // Group results by type
            const workspaceResults = results.filter(r => !r.isDependency && !r.isStdlib);
            const dependencyResults = results.filter(r => r.isDependency);
            const stdlibResults = results.filter(r => r.isStdlib);
            
            let html = '';
            
            // Add index status if available
            if (indexStatus) {
                html += '<div class="index-status">' + escapeHtml(indexStatus) + '</div>';
            }
            
            // Workspace results
            if (workspaceResults.length > 0) {
                html += '<div class="result-group">';
                html += '<div class="result-group-header"><span>🏠 Workspace</span><span>(' + workspaceResults.length + ')</span></div>';
                workspaceResults.forEach(result => {
                    html += createResultItem(result, searchText);
                });
                html += '</div>';
            }
            
            // Dependency results
            if (dependencyResults.length > 0) {
                html += '<div class="result-group">';
                html += '<div class="result-group-header"><span>📦 Dependencies</span><span>(' + dependencyResults.length + ')</span></div>';
                dependencyResults.forEach(result => {
                    html += createResultItem(result, searchText);
                });
                html += '</div>';
            }
            
            // Stdlib results
            if (stdlibResults.length > 0) {
                html += '<div class="result-group">';
                html += '<div class="result-group-header"><span>⚡ Standard Library</span><span>(' + stdlibResults.length + ')</span></div>';
                stdlibResults.forEach(result => {
                    html += createResultItem(result, searchText);
                });
                html += '</div>';
            }
            
            resultsDiv.innerHTML = html;
        }
    `;
} 