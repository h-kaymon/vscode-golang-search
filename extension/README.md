# Golang Library Search Extension

This Cursor extension helps you search globally across Golang projects, including searching within dependency library files after running go mod tidy.

## Features

- Search for code content in Golang project dependencies
- Support direct navigation to dependency library code locations
- Compatible with standard Golang module projects
- Display search results in sidebar with highlighted keywords
- Prioritize non-test files in search results

## Usage

1. Open a Golang project containing a `go.mod` file
2. Run the "search golang files and dependencies" command via the command palette **(Cmd+Shift+P)**
3. Enter the keywords to search for
4. View search results, click on a result to jump to the corresponding library file location

## Requirements

- Go language environment installed
- Project must be based on Go modules (containing a go.mod file)
- Dependencies must have been downloaded with `go mod tidy` or `go mod download`

## How It Works

The extension implements global search through the following steps:

1. Uses `go env GOMODCACHE` to get the location of the Go module cache
2. Uses `go list -m all` to get all modules that the project depends on
3. Searches for user-specified keywords in the module cache using grep
4. Converts search results to location information that VSCode/Cursor can understand
5. Displays matches in the search results panel with highlighted keywords

## Features in Detail

- **Real-time Search**: Results update as you type (with debounce)
- **Workspace + Dependencies**: Searches both workspace files and dependencies
- **Result Prioritization**: Non-test files are prioritized over test files
- **Visual Distinction**: Dependency results are marked with a gold border
- **Keyword Highlighting**: Search terms are highlighted in the results
- **Sidebar Integration**: Dedicated search view in the activity bar
- **Statistics**: Shows counts of regular and test files in results

## Feedback

If you have any issues or suggestions, please submit an issue. 

---
<br><br><br><br>

# 中文版本
# Golang库搜索插件

这个Cursor插件可以帮助您在Golang项目中全局搜索，包括搜索go mod tidy后的依赖库文件内容。

## 功能

- 在Golang项目中搜索依赖库中的代码内容
- 支持直接跳转到依赖库的代码位置
- 兼容标准Golang模块项目
- 在侧边栏中显示搜索结果，关键词高亮显示
- 优先显示非测试文件在搜索结果中

## 使用方法

1. 打开一个包含`go.mod`文件的Golang项目
2. 通过命令面板（Cmd+Shift+P）运行"search golang files and dependencies"命令
3. 输入要搜索的关键字
4. 查看搜索结果，点击结果可跳转到对应的库文件位置
5. 也可以使用左侧活动栏中的搜索图标直接在侧边栏进行搜索

## 要求

- 需要安装Go语言环境
- 项目必须是基于Go模块的项目（包含go.mod文件）
- 需要执行过`go mod tidy`或`go mod download`来下载依赖

## 实现原理

插件通过以下步骤实现全局搜索功能：

1. 使用`go env GOMODCACHE`获取Go模块缓存的位置
2. 使用`go list -m all`获取项目依赖的所有模块
3. 在模块缓存中使用grep搜索用户指定的关键字
4. 将搜索结果转换为VSCode/Cursor可以理解的位置信息
5. 在搜索结果面板中显示匹配项，并高亮关键词

## 功能详情

- **实时搜索**: 输入时即时更新结果（带防抖动）
- **工作区+依赖**: 同时搜索工作区文件和依赖库
- **结果优先级**: 非测试文件优先于测试文件显示
- **视觉区分**: 依赖库结果用金色边框标记，测试文件用灰蓝色边框标记
- **关键词高亮**: 搜索词在结果中高亮显示
- **侧边栏集成**: 在活动栏中提供专用搜索视图
- **统计信息**: 显示常规文件和测试文件的数量统计

## 问题反馈

如有问题或建议，请提交issue。

---