#!/usr/bin/env python3
"""
Simple Python dead code detection script.
Finds potentially unused functions, classes, and imports in Python files.
"""

import ast
import os
import sys
from typing import Set, Dict, List
from collections import defaultdict


class DeadCodeDetector(ast.NodeVisitor):
    """AST visitor to detect potentially unused code in Python files."""
    
    def __init__(self):
        self.defined_functions: Set[str] = set()
        self.defined_classes: Set[str] = set()
        self.defined_variables: Set[str] = set()
        self.imported_names: Set[str] = set()
        self.used_names: Set[str] = set()
        self.function_calls: Set[str] = set()
        self.attribute_accesses: Set[str] = set()
        
    def visit_FunctionDef(self, node):
        """Track function definitions."""
        self.defined_functions.add(node.name)
        # Don't consider special methods as unused
        if not (node.name.startswith('__') and node.name.endswith('__')):
            pass  # We'll check if it's used later
        self.generic_visit(node)
        
    def visit_AsyncFunctionDef(self, node):
        """Track async function definitions."""
        self.defined_functions.add(node.name)
        self.generic_visit(node)
        
    def visit_ClassDef(self, node):
        """Track class definitions."""
        self.defined_classes.add(node.name)
        self.generic_visit(node)
        
    def visit_Import(self, node):
        """Track imports."""
        for alias in node.names:
            name = alias.asname if alias.asname else alias.name
            self.imported_names.add(name)
        self.generic_visit(node)
        
    def visit_ImportFrom(self, node):
        """Track from imports."""
        for alias in node.names:
            name = alias.asname if alias.asname else alias.name
            self.imported_names.add(name)
        self.generic_visit(node)
        
    def visit_Name(self, node):
        """Track name usage."""
        if isinstance(node.ctx, ast.Load):
            self.used_names.add(node.id)
        elif isinstance(node.ctx, ast.Store):
            self.defined_variables.add(node.id)
        self.generic_visit(node)
        
    def visit_Call(self, node):
        """Track function calls."""
        if isinstance(node.func, ast.Name):
            self.function_calls.add(node.func.id)
        elif isinstance(node.func, ast.Attribute):
            self.attribute_accesses.add(node.func.attr)
        self.generic_visit(node)
        
    def visit_Attribute(self, node):
        """Track attribute access."""
        self.attribute_accesses.add(node.attr)
        self.generic_visit(node)


def analyze_file(file_path: str) -> Dict[str, List[str]]:
    """Analyze a Python file for dead code."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            
        tree = ast.parse(content, filename=file_path)
        detector = DeadCodeDetector()
        detector.visit(tree)
        
        issues = defaultdict(list)
        
        # Check for unused functions
        unused_functions = detector.defined_functions - detector.function_calls - detector.used_names
        # Filter out common patterns that might not be directly called
        # Also filter out AST visitor methods (they're called by the AST framework)
        unused_functions = {f for f in unused_functions 
                          if not f.startswith('_') 
                          and f not in ['main', 'setup', 'teardown']
                          and not f.startswith('visit_')}  # AST visitor methods
        if unused_functions:
            issues['unused_functions'].extend(sorted(unused_functions))
            
        # Check for unused classes
        unused_classes = detector.defined_classes - detector.used_names
        if unused_classes:
            issues['unused_classes'].extend(sorted(unused_classes))
            
        # Check for unused imports
        unused_imports = detector.imported_names - detector.used_names - detector.function_calls
        # Filter out common imports that might be used indirectly
        unused_imports = {i for i in unused_imports 
                         if i not in ['os', 'sys', 'typing', 'Optional', 'List', 'Dict', 'Any']}
        if unused_imports:
            issues['unused_imports'].extend(sorted(unused_imports))
            
        return dict(issues)
        
    except SyntaxError as e:
        return {'syntax_errors': [f"Syntax error: {e}"]}
    except Exception as e:
        return {'analysis_errors': [f"Analysis error: {e}"]}


def main():
    """Main function to analyze current directory or specified files."""
    if len(sys.argv) > 1:
        files_to_check = sys.argv[1:]
    else:
        # Check all Python files in current directory
        files_to_check = []
        for root, dirs, files in os.walk('.'):
            # Skip common directories that shouldn't be analyzed
            dirs[:] = [d for d in dirs if d not in ['__pycache__', '.git', 'node_modules', 'venv', 'env']]
            for file in files:
                if file.endswith('.py'):
                    files_to_check.append(os.path.join(root, file))
    
    found_issues = False
    
    for file_path in files_to_check:
        if not file_path.endswith('.py'):
            continue
            
        issues = analyze_file(file_path)
        if issues:
            found_issues = True
            print(f"\n=== {file_path} ===")
            
            for issue_type, items in issues.items():
                if items:
                    print(f"{issue_type.replace('_', ' ').title()}:")
                    for item in items:
                        print(f"  - {item}")
    
    if not found_issues:
        print("No obvious dead code detected.")


if __name__ == '__main__':
    main()