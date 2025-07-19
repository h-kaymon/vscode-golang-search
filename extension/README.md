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
2. Run the "search golang files and dependencies" command via the command palette (Cmd+Shift+P)
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
[Chinese Version](./README_cn.md) 