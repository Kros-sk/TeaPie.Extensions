# TeaPie Extensions

VS Code extension for TeaPie testing framework.

## Features

- Run all tests in a directory
- Run a single test file
- Run tests up to a specific file
- Cycle between test files (init.csx -> req.http -> test.csx)
- Navigate to next test case in current directory
- Navigate to next test case across all directories
- Generate new test case with automatic file opening
- TeaPie Explorer with test case tree view
- Explore collection structure
- Quick access to test files via icons

## Commands

- `TeaPie: Run Tests` - Run all tests in the selected directory
- `TeaPie: Run Test` - Run the test file and its corresponding .http file
- `TeaPie: Run Tests To Here` - Run all tests up to the selected file
- `TeaPie: Cycle Test Files` - Cycle between test files (init.csx -> req.http -> test.csx)
- `TeaPie: Next Test Case` - Navigate to the next test case in the current directory
- `TeaPie: Next Test Case (Include Subdirectories)` - Navigate to the next test case across all directories
- `TeaPie: Generate New Test Case` - Generate a new test case and open the .http file
- `TeaPie: Explore Collection` - Show the structure of test cases in the output window
- `TeaPie: Refresh Explorer` - Refresh the TeaPie Explorer tree view

## TeaPie Explorer

The TeaPie Explorer provides a tree view of your test cases organized by directories. Each test case shows:
- HTTP request file
- Test file
- Init file (if exists)

Features available in the explorer:
- Click on a file to open it
- Click on a test case to open its HTTP file
- Use inline commands to run tests or open files
- Group test cases by their names
- Human-readable test case names

## Context Menu

Right-click menu is available in:
1. TeaPie Explorer
   - Open file
   - Run test
   - Run tests to here
   - Run all tests in directory

2. Solution Explorer
   - Run tests (on directories)
   - Run test (on .http and .csx files)
   - Run tests to here (on .http and .csx files)
   - Generate new test case (on directories)
   - Explore collection (on directories)

## Keybindings

- `F7` - Cycle between test files
- `Alt+F7` - Navigate to next test case in current directory
- `Ctrl+Alt+F7` - Navigate to next test case across all directories

## Development

### Prerequisites

- Node.js
- npm
- VS Code Extension Manager (vsce)

### Building the Extension

1. Install dependencies:
```bash
npm install
```

2. Compile the extension:
```bash
npm run compile
```

3. Create VSIX package:
```bash
vsce package
```

The compiled extension will be in the `out` directory and the VSIX package will be created in the root directory.

### Installing the Extension

1. Open VS Code
2. Press `Ctrl+Shift+P` to open the command palette
3. Type "Install from VSIX"
4. Select the VSIX package file
5. Restart VS Code

Alternatively, you can install from the command line:
```bash
code --install-extension teapie-extensions-0.0.4.vsix
```

## Requirements

- VS Code 1.85.0 or higher
- TeaPie CLI installed and available in PATH 