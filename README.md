# TeaPie Extensions for VS Code

![TeaPie Extensions Logo](https://github.com/Kros-sk/TeaPie.Extensions/blob/master/resources/teapie.png?raw=true)

A Visual Studio Code extension that provides seamless integration with TeaPie, allowing you to run and manage your HTTP tests directly from VS Code.

Visit [TeaPie website](https://www.teapie.fun/) to learn more about the testing framework.

## Features

- 🚀 Run TeaPie tests directly from VS Code
- 📁 Test case management through the TeaPie Explorer
- ⌨️ Keyboard shortcuts for efficient test execution
- 🔄 Automatic test file cycling
- 📝 HTTP file preview support
- 🔍 Easy navigation between test cases
- 🎨 Syntax highlighting for .http files (directives, methods, headers, etc.)
- 💡 IntelliSense support for TeaPie directives

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

### Keyboard Shortcuts

- `F5` - Run the current test
- `F6` - Preview HTTP file
- `F7` - Cycle through test files
- `Alt+F7` - Move to next test case
- `Ctrl+Alt+F7` - Move to next test case (including subdirectories)

### Context Menu Actions

Right-click on files or folders in the TeaPie Explorer to access additional actions:

- Run tests
- Generate new test cases
- Preview HTTP files
- Shift subsequent tests

## Requirements

- TeaPie installed on your system

## Release Notes

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