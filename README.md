# Golang库搜索插件项目

这个项目是一个为Cursor编辑器开发的插件，目的是实现在Golang项目中通过全局搜索关键字，能够搜索到go mod tidy之后的库文件里面的内容，类似GoLand的功能。

## 项目结构

- `extension/`: 包含Cursor插件源代码
  - `src/`: 插件的TypeScript源代码
  - `package.json`: 插件配置文件
  - `tsconfig.json`: TypeScript配置
  - `webpack.config.js`: 打包配置
  - `README.md`: 插件说明
  - `INSTALL.md`: 安装指南
- `src/`: 示例Go项目，用于测试插件功能

## 主要功能

- 在Golang项目中全局搜索，包括依赖库内容
- 支持搜索go mod管理的所有依赖库
- 支持在搜索结果中直接跳转到依赖库文件
- 与Cursor编辑器无缝集成

## 实现原理

该插件通过以下步骤实现全局搜索功能：

1. 使用Go工具获取GOMODCACHE路径（依赖库的存储位置）
2. 使用`go list -m all`命令获取当前项目的所有依赖模块
3. 使用grep工具在这些依赖库中搜索关键字
4. 将搜索结果以适当的格式呈现在Cursor编辑器中
5. 支持用户直接点击搜索结果跳转到对应文件位置

## 安装和使用

详细的安装说明见 [extension/INSTALL.md](extension/INSTALL.md)。
插件的具体使用方法见 [extension/README.md](extension/README.md)。

## 开发环境要求

- Node.js 和 npm（用于插件开发）
- Go语言环境（用于示例项目和依赖管理）
- Cursor编辑器或VS Code

## 参与贡献

欢迎提交问题报告或功能请求。如果您想贡献代码，请先开issue讨论您想要实现的功能。 