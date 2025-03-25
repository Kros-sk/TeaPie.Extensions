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

## Commands

- `TeaPie: Run Directory` - Run all tests in the selected directory
- `TeaPie: Run File` - Run the test file and its corresponding .http file
- `TeaPie: Run To File` - Run all tests up to the selected file
- `TeaPie: Cycle Test Files` - Cycle between test files (init.csx -> req.http -> test.csx)
- `TeaPie: Next Test Case` - Navigate to the next test case in the current directory
- `TeaPie: Next Test Case (Include Subdirectories)` - Navigate to the next test case across all directories
- `TeaPie: Generate New Test Case` - Generate a new test case and open the .http file

## Keybindings

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

- VS Code 1.60.0 or higher
- TeaPie CLI installed and available in PATH 