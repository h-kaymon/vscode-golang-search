# Golang Library Search Extension

This Cursor extension helps you search globally across Golang projects with **blazing-fast parallel search**, including searching within dependency library files and Go standard library.

## Features

- **⚡ Parallel search engine** - Search multiple dependencies simultaneously  
- **🚀 Smart concurrency control** - Configurable parallel processing (up to 20x faster)
- **🔍 Go standard library search** - Search within Go's built-in packages and tools
- **📦 Dependency library search** - Search through all your project dependencies
- **💡 Intelligent prioritization** - Non-test files and workspace results prioritized
- **🎯 Real-time results** - Instant search with debounced input
- **⚙️ Configurable performance** - Adjust concurrency based on your system

## Performance Improvements

This extension uses **parallel search architecture** for maximum performance:

### Search Engine Options
- **Ripgrep (default)**: Fast regex engine with parallel execution
- **Grep**: Fallback option for maximum compatibility

### Parallel Processing Benefits
- **Multiple dependencies searched simultaneously** instead of sequentially
- **Configurable concurrency** - Default 6 parallel searches, adjustable up to 20
- **Smart timeout handling** - Prevents slow dependencies from blocking results
- **Intelligent result limiting** - Balanced results from all sources

## Quick Configuration

Optimize performance in VS Code settings:

1. Open Settings (Cmd/Ctrl + ,)
2. Search for "golang search"
3. Adjust settings:
   - **Search Engine**: ripgrep (recommended) or grep
   - **Max Concurrent Searches**: 6 (default) - increase for more speed
   - **Search Timeout**: 30 seconds (default)

### Configuration Options

```json
{
  "golang-search.searchEngine": "ripgrep",           // ripgrep or grep
  "golang-search.maxConcurrentSearches": 6,          // 1-20 parallel searches
  "golang-search.searchTimeout": 30                  // timeout in seconds
}
```

## Requirements

- Go language environment installed
- Project must be based on Go modules (containing a go.mod file)  
- Dependencies must have been downloaded with `go mod tidy` or `go mod download`
- **Recommended**: Install [ripgrep](https://github.com/BurntSushi/ripgrep) for optimal performance
  - macOS: `brew install ripgrep`
  - Ubuntu/Debian: `apt install ripgrep`
  - Windows: `choco install ripgrep` or download from GitHub releases
  - **Note**: The extension works without ripgrep but will be slower

## Usage

1. Open a Golang project containing a `go.mod` file
2. Run the "search golang files and dependencies" command via the command palette **(Cmd+Shift+P)**
3. Enter the keywords to search for
4. View search results, click on a result to jump to the corresponding library file location

## How It Works

The extension implements parallel global search through the following steps:

1. Uses `go env GOMODCACHE` to get the location of the Go module cache
2. Uses `go env GOROOT` to get the Go installation path and locate standard library source code
3. Uses `go list -m all` to get all modules that the project depends on
4. **Parallel execution**: Searches workspace, standard library, and all dependencies simultaneously
5. **Smart concurrency**: Limits parallel processes to prevent system overload
6. Converts search results to location information that VSCode/Cursor can understand
7. Displays matches in the search results panel with highlighted keywords, grouped by source type

## Features in Detail

- **Real-time Search**: Results update as you type (with debounce)
- **Parallel Architecture**: Multiple dependencies searched simultaneously
- **Smart Resource Management**: Configurable concurrency with timeout protection
- **Workspace + Dependencies + Stdlib**: Comprehensive search coverage
- **Result Prioritization**: Non-test files prioritized over test files
- **Visual Distinction**: Different colors for workspace, stdlib, and dependency results
- **Keyword Highlighting**: Search terms are highlighted in the results
- **Sidebar Integration**: Dedicated search view in the activity bar
- **Statistics**: Shows counts of regular and test files in results
- **Performance Monitoring**: Console logs show search progress and timing

## Performance Tuning

### For Fast Systems (8+ cores, SSD)
```json
{
  "golang-search.maxConcurrentSearches": 12,
  "golang-search.searchTimeout": 15
}
```

### For Slower Systems (4 cores, slower disk)
```json
{
  "golang-search.maxConcurrentSearches": 3,
  "golang-search.searchTimeout": 45  
}
```

### For Large Projects (100+ dependencies)
```json
{
  "golang-search.maxConcurrentSearches": 8,
  "golang-search.searchTimeout": 60
}
```

## Cross-Platform Compatibility

This extension works seamlessly across all platforms:
- ✅ **macOS**: Native timeout handling, no external dependencies
- ✅ **Linux**: Full ripgrep and grep support
- ✅ **Windows**: Complete cross-platform compatibility

## Feedback

If you have any issues or suggestions, please submit an issue.

---

<br><br>

# 中文版本
# Golang库搜索插件

这个Cursor插件可以帮助您在Golang项目中全局搜索，使用**闪电般的并行搜索**，包括搜索依赖库文件内容和Go标准库。

## 功能

- **⚡ 并行搜索引擎** - 同时搜索多个依赖库
- **🚀 智能并发控制** - 可配置并行处理（速度提升最多20倍）
- **🔍 Go标准库搜索** - 搜索Go内置包和工具的源码
- **📦 依赖库搜索** - 搜索项目的所有依赖库
- **💡 智能优先级** - 非测试文件和工作区结果优先显示
- **🎯 实时结果** - 带防抖动的即时搜索
- **⚙️ 可配置性能** - 根据系统调整并发数

## 性能提升

该插件使用**并行搜索架构**以获得最大性能：

### 搜索引擎选项
- **Ripgrep（默认）**: 快速正则表达式引擎，支持并行执行
- **Grep**: 最大兼容性的回退选项

### 并行处理优势
- **多个依赖库同时搜索**，而不是串行搜索
- **可配置并发数** - 默认6个并行搜索，最高可调至20个
- **智能超时处理** - 防止慢速依赖阻塞结果
- **智能结果限制** - 从所有源获得平衡的结果

## 快速配置

在VS Code设置中优化性能：

1. 打开设置 (Cmd/Ctrl + ,)
2. 搜索 "golang search"
3. 调整设置：
   - **搜索引擎**: ripgrep（推荐）或grep
   - **最大并发搜索数**: 6（默认）- 增加以获得更快速度
   - **搜索超时**: 30秒（默认）

### 配置选项

```json
{
  "golang-search.searchEngine": "ripgrep",           // ripgrep 或 grep
  "golang-search.maxConcurrentSearches": 6,          // 1-20 个并行搜索
  "golang-search.searchTimeout": 30                  // 超时时间（秒）
}
```

## 要求

- 需要安装Go语言环境
- 项目必须是基于Go模块的项目（包含go.mod文件）
- 需要执行过`go mod tidy`或`go mod download`来下载依赖
- **推荐**: 安装 [ripgrep](https://github.com/BurntSushi/ripgrep) 以获得最佳性能
  - macOS: `brew install ripgrep`
  - Ubuntu/Debian: `apt install ripgrep`
  - Windows: `choco install ripgrep` 或从GitHub releases下载
  - **注意**: 没有ripgrep插件仍可工作，但速度较慢

## 使用方法

1. 打开一个包含`go.mod`文件的Golang项目
2. 通过命令面板（Cmd+Shift+P）运行"search golang files and dependencies"命令
3. 输入要搜索的关键字
4. 查看搜索结果，点击结果可跳转到对应的库文件位置

## 实现原理

插件通过以下步骤实现并行全局搜索功能：

1. 使用`go env GOMODCACHE`获取Go模块缓存的位置
2. 使用`go env GOROOT`获取Go安装路径并定位标准库源码
3. 使用`go list -m all`获取项目依赖的所有模块
4. **并行执行**: 同时搜索工作区、标准库和所有依赖库
5. **智能并发**: 限制并行进程数量，防止系统过载
6. 将搜索结果转换为VSCode/Cursor可以理解的位置信息
7. 在搜索结果面板中显示匹配项，按来源类型分组，并高亮关键词

## 功能详情

- **实时搜索**: 输入时即时更新结果（带防抖动）
- **并行架构**: 多个依赖库同时搜索
- **智能资源管理**: 可配置并发数和超时保护
- **工作区+依赖+标准库**: 全面搜索覆盖
- **结果优先级**: 非测试文件优先于测试文件显示
- **视觉区分**: 工作区、标准库和依赖库结果使用不同颜色标记
- **关键词高亮**: 搜索词在结果中高亮显示
- **侧边栏集成**: 在活动栏中提供专用搜索视图
- **统计信息**: 显示常规文件和测试文件的数量统计
- **性能监控**: 控制台日志显示搜索进度和时间

## 性能调优

### 快速系统（8+核心，SSD）
```json
{
  "golang-search.maxConcurrentSearches": 12,
  "golang-search.searchTimeout": 15
}
```

### 较慢系统（4核心，慢速磁盘）
```json
{
  "golang-search.maxConcurrentSearches": 3,
  "golang-search.searchTimeout": 45
}
```

### 大型项目（100+依赖）
```json
{
  "golang-search.maxConcurrentSearches": 8,
  "golang-search.searchTimeout": 60
}
```

## 跨平台兼容性

该扩展在所有平台上无缝工作：
- ✅ **macOS**: 原生超时处理，无外部依赖
- ✅ **Linux**: 完整的ripgrep和grep支持
- ✅ **Windows**: 完全跨平台兼容

## 问题反馈

如有问题或建议，请提交issue。

---