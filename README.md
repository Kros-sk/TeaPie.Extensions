# TeaPie Extensions for VS Code

![TeaPie Extensions Logo](/resources/teapie-horizontal.png)

A Visual Studio Code extension that provides seamless integration with TeaPie, allowing you to run and manage your HTTP tests directly from VS Code.

Visit [TeaPie website](https://www.teapie.fun/) to learn more about the testing framework.

## Features

- 🚀 Run TeaPie tests directly from VS Code
- 📁 Test case management through the TeaPie Explorer
- ⌨️ Keyboard shortcuts for efficient test execution
- 🔄 Automatic test file cycling
- 📝 HTTP file preview support
- 🌐 Run HTTP requests directly from .http files and preview the results
- 🔍 Easy navigation between test cases
- 🎨 Syntax highlighting for .http files (directives, methods, headers, etc.)
- 💡 IntelliSense support for TeaPie directives
- 📊 Test results view with detailed statistics and execution times
- 🔧 Visual Variables Editor for managing TeaPie variables
- 🌍 Environment Editor with environment switching support

## Usage

### Commands

- `TeaPie: Run Tests` - Run all tests in the current directory
- `TeaPie: Run Test (F5)` - Run the currently selected test
- `TeaPie: Cycle Test Files (F7)` - Navigate between test files
- `TeaPie: Next Test Case (Alt+F7)` - Move to the next test case
- `TeaPie: Next Test Case (Include Subdirectories) (Ctrl+Alt+F7)` - Move to the next test case including subdirectories
- `TeaPie: Generate New Test Case` - Create a new test case
- `TeaPie: Explore Collection` - Browse your test collection
- `TeaPie: Refresh Explorer` - Refresh the TeaPie Explorer view
- `TeaPie: Open HTML Preview (F6)` - Open the current HTTP file in HTML preview mode
- `TeaPie: Run HTTP Request (F8)` - Run the HTTP request in the current file
- `TeaPie: Compile Script (Ctrl+Alt+K)` - Compile C# scripts
- `TeaPie: Open Documentation` - Open [TeaPie documentation](https://www.teapie.fun) in your default browser
- `TeaPie: Focus on Test Results` - Focus on the Test Results view
- `TeaPie: Open Variables Editor (Ctrl+Alt+V)` - Open the visual editor for managing TeaPie variables
- `TeaPie: Open Environment Editor (Ctrl+Alt+N)` - Open the visual editor for managing environments

### Keyboard Shortcuts

- `F5` - Run the current test
- `F6` - Preview HTTP file
- `F7` - Cycle through test files
- `F8` - Run HTTP Request
- `Alt+F7` - Move to next test case
- `Ctrl+Alt+F7` - Move to next test case (including subdirectories)
- `Ctrl+Alt+K` - Compile Script
- `Ctrl+Alt+V` - Open Variables Editor
- `Ctrl+Alt+N` - Open Environment Editor

### Context Menu Actions

Right-click on files or folders in the TeaPie Explorer to access additional actions:

- Run tests
- Generate new test cases
- Preview HTTP files
- Shift subsequent tests
- Open Variables Editor
- Open Environment Editor

### Environment Management

The Environment Editor allows you to:

- Create and manage multiple environments (local, development, staging, production, etc.)
- Define shared variables that are available across all environments
- Switch between environments using the status bar indicator
- Edit environment-specific variables with a user-friendly interface
- Automatically save and load environment configurations

## Requirements

- TeaPie installed on your system

## Release Notes

### 0.0.31

- ✨ Added HTTP request execution and overview enhancements
  - New F8 shortcut to run HTTP requests directly from .http files
  - Added HTTP overview window to view requests and their responses

### 0.0.27

- ✨ Added C# Script Compilation Support
  - New command to compile C# scripts (`Ctrl+Alt+K / Cmd+Alt+K`)
  - Automatic compilation of test and initialization scripts
  - Improved error reporting for compilation issues
  - Support for both `-test.csx` and `-init.csx` files

### 0.0.23

- ✨ Added Environment Editor and Environment Switching
  - Visual interface for managing multiple environments
  - Environment selector in status bar for quick switching
  - Support for shared variables across environments
  - Keyboard shortcut (Ctrl+Alt+N) for quick access
  - Automatic file watching for external changes
  - Environment configuration stored in `.teapie/env.json`

### 0.0.22

- ✨ Added keyboard shortcut for Variables Editor
  - Quick access to Variables Editor with Ctrl+Alt+V (Cmd+Alt+V on macOS)
  - Makes it easier to manage variables across your test collection

### 0.0.21

- ✨ Added Variables Editor for managing TeaPie variables
  - Visual interface for editing variables in all scopes (Global, Environment, Collection, Test Case)
  - Accessible from TeaPie Explorer and context menu
  - Manual save functionality to control when changes are applied
  - Automatic file watching to detect external changes

### 0.0.17

- ✨ Added new command to open TeaPie documentation
  - Quick access to [TeaPie documentation website](https://www.teapie.fun)
  - Available through Command Palette under TeaPie category

### 0.0.16

- ✨ Enhanced HTTP file preview with variable support
  - Added ability to view TeaPie variables in HTTP preview
  - Toggle between variable names and their values
  - Variables are loaded from `.teapie/cache/variables/variables.json`
  - Support for all variable scopes (Global, Environment, Collection, TestCase)
  - Real-time preview updates when toggling between variable names and values

### 0.0.11

Initial release with basic TeaPie integration features.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## ⚠️ Disclaimer

This extension was generated using artificial intelligence. While we strive for accuracy, there may be bugs or issues that need to be addressed. Please report any problems you encounter through GitHub issues.
