#!/usr/bin/env python3
"""
ARCANOS Python AST-based dead code detector
Analyzes Python files for unused functions, classes, and imports.
"""

import ast
import os
import sys
from typing import Set, Dict, List, Tuple
from collections import defaultdict


class UnusedCodeAnalyzer(ast.NodeVisitor):
    """AST visitor that analyzes Python code for unused elements."""
    
    def __init__(self, filepath: str):
        self.filepath = filepath
        self.defined_functions: Set[str] = set()
        self.defined_classes: Set[str] = set()
        self.imported_names: Set[str] = set()
        self.used_names: Set[str] = set()
        self.function_defs: Dict[str, int] = {}  # name -> line number
        self.class_defs: Dict[str, int] = {}    # name -> line number
        self.import_defs: Dict[str, int] = {}   # name -> line number
        self.issues: List[Tuple[str, int, str]] = []  # (type, line, message)
        
    def visit_FunctionDef(self, node):
        """Visit function definitions."""
        # Skip special methods and common patterns
        if not (node.name.startswith('_') or 
                node.name in ['visit_', 'main', 'setup', 'teardown'] or
                any(decorator.id == 'staticmethod' if hasattr(decorator, 'id') else False 
                    for decorator in node.decorator_list)):
            self.defined_functions.add(node.name)
            self.function_defs[node.name] = node.lineno
        self.generic_visit(node)
        
    def visit_AsyncFunctionDef(self, node):
        """Visit async function definitions."""
        if not node.name.startswith('_'):
            self.defined_functions.add(node.name)
            self.function_defs[node.name] = node.lineno
        self.generic_visit(node)
        
    def visit_ClassDef(self, node):
        """Visit class definitions."""
        self.defined_classes.add(node.name)
        self.class_defs[node.name] = node.lineno
        self.generic_visit(node)
        
    def visit_Import(self, node):
        """Visit import statements."""
        for alias in node.names:
            name = alias.asname if alias.asname else alias.name
            # Skip common system imports
            if not alias.name.startswith('sys') and alias.name not in ['os', 'json', 'time']:
                self.imported_names.add(name)
                self.import_defs[name] = node.lineno
        self.generic_visit(node)
        
    def visit_ImportFrom(self, node):
        """Visit from...import statements."""
        for alias in node.names:
            if alias.name != '*':
                name = alias.asname if alias.asname else alias.name
                # Skip common patterns
                if name not in ['__version__', '__all__']:
                    self.imported_names.add(name)
                    self.import_defs[name] = node.lineno
        self.generic_visit(node)
        
    def visit_Name(self, node):
        """Visit name references."""
        if isinstance(node.ctx, ast.Load):
            self.used_names.add(node.id)
        self.generic_visit(node)
        
    def visit_Attribute(self, node):
        """Visit attribute access."""
        # Extract base name for attribute access
        if hasattr(node.value, 'id'):
            self.used_names.add(node.value.id)
        self.generic_visit(node)
        
    def analyze(self) -> List[Tuple[str, int, str]]:
        """Analyze the code and return issues found."""
        # Find unused functions
        for func_name, line_no in self.function_defs.items():
            if func_name not in self.used_names:
                self.issues.append(('unused_function', line_no, f"Unused function '{func_name}'"))
                
        # Find unused classes  
        for class_name, line_no in self.class_defs.items():
            if class_name not in self.used_names:
                self.issues.append(('unused_class', line_no, f"Unused class '{class_name}'"))
                
        # Find unused imports
        for import_name, line_no in self.import_defs.items():
            if import_name not in self.used_names:
                self.issues.append(('unused_import', line_no, f"Unused import '{import_name}'"))
                
        return self.issues


def analyze_python_file(filepath: str) -> Dict:
    """Analyze a single Python file for unused code."""
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
            
        tree = ast.parse(content, filepath)
        analyzer = UnusedCodeAnalyzer(filepath)
        analyzer.visit(tree)
        issues = analyzer.analyze()
        
        return {
            'filepath': filepath,
            'status': 'success',
            'issues': issues,
            'statistics': {
                'functions_defined': len(analyzer.defined_functions),
                'classes_defined': len(analyzer.defined_classes),
                'imports_defined': len(analyzer.imported_names),
                'total_issues': len(issues)
            }
        }
        
    except SyntaxError as e:
        return {
            'filepath': filepath,
            'status': 'syntax_error',
            'error': f"Syntax error at line {e.lineno}: {e.msg}",
            'issues': [],
            'statistics': {}
        }
    except Exception as e:
        return {
            'filepath': filepath,
            'status': 'error',
            'error': str(e),
            'issues': [],
            'statistics': {}
        }


def scan_directory(directory: str, skip_dirs: List[str] = None) -> List[Dict]:
    """Scan directory for Python files and analyze them."""
    if skip_dirs is None:
        skip_dirs = ['__pycache__', '.git', 'node_modules', 'venv', '.venv']
    
    results = []
    
    for root, dirs, files in os.walk(directory):
        # Skip specified directories
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        
        for file in files:
            if file.endswith('.py'):
                filepath = os.path.join(root, file)
                result = analyze_python_file(filepath)
                results.append(result)
                
    return results


if __name__ == '__main__':
    """Command line interface for the unused code analyzer."""
    directory = sys.argv[1] if len(sys.argv) > 1 else '.'
    
    print(f"🐍 Analyzing Python files in: {directory}")
    results = scan_directory(directory)
    
    total_issues = 0
    files_with_issues = 0
    
    for result in results:
        if result['issues']:
            files_with_issues += 1
            print(f"\n📄 {result['filepath']}:")
            
            for issue_type, line_no, message in result['issues']:
                print(f"  Line {line_no}: {message}")
                total_issues += 1
                
        elif result['status'] == 'syntax_error':
            print(f"\n❌ {result['filepath']}: {result['error']}")
            
    print(f"\n📊 Analysis Summary:")
    print(f"   Files analyzed: {len(results)}")
    print(f"   Files with issues: {files_with_issues}")
    print(f"   Total issues found: {total_issues}")