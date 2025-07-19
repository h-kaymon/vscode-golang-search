# Golang库搜索插件安装说明

## 前置条件

安装此插件需要以下工具：

1. Node.js 和 npm (推荐使用 Node.js v14 或更新版本)
2. Go语言环境
3. VS Code或Cursor编辑器

## 使用方法

1. 打开包含`go.mod`文件的Golang项目
2. 通过命令面板（Cmd+Shift+P或Ctrl+Shift+P）运行"在Golang依赖库中搜索"命令
3. 输入要搜索的关键字
4. 查看搜索结果，点击结果可跳转到对应的库文件位置

## 常见问题

### 无法搜索依赖库

1. 确保已执行`go mod tidy`或`go mod download`下载依赖
2. 检查GOMODCACHE环境变量是否正确设置
3. 确保grep命令在系统中可用（Windows系统可能需要安装Git Bash或WSL）

### 插件无法激活

1. 检查是否处于Go语言项目中
2. 确保项目包含有效的go.mod文件
3. 查看VS Code/Cursor的输出面板中有无错误信息

## 调试插件

如需调试插件，可以：

1. 在VS Code中打开插件项目
2. 按F5键启动调试会话
3. 新窗口中将加载插件的调试版本
4. 可以在代码中设置断点进行调试

## 重新编译

修改代码后需要重新编译：

```bash
npm run compile
```

如果在开发模式下，可以使用监视模式：

```bash
npm run watch
``` 