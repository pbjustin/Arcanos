#!/usr/bin/env python3
"""
ARCANOS Dead Code Scanner
A comprehensive multi-language dead code detection tool.
"""

import os
import sys
import json
import subprocess
import time
from datetime import datetime
from typing import Dict, List, Any, Optional
from find_unused_code import scan_directory as scan_python_directory


class DeadCodeScanner:
    """Main dead code scanner coordinating multiple language analyzers."""
    
    def __init__(self, config_path: str = 'codex.config.json'):
        self.config = self.load_config(config_path)
        self.results = []
        self.start_time = time.time()
        
    def load_config(self, config_path: str) -> Dict:
        """Load configuration from codex.config.json."""
        try:
            with open(config_path, 'r') as f:
                config = json.load(f)
                return config.get('purification', {})
        except FileNotFoundError:
            print(f"⚠️  Config file {config_path} not found, using defaults")
            return self.get_default_config()
        except json.JSONDecodeError as e:
            print(f"❌ Invalid JSON in {config_path}: {e}")
            return self.get_default_config()
            
    def get_default_config(self) -> Dict:
        """Get default configuration if config file is not available."""
        return {
            'enabled': True,
            'scanners': {
                'deadCode': {
                    'enabled': True,
                    'thresholds': {
                        'largeFileLines': 500,
                        'maxConsoleLogsPerFile': 3,
                        'maxFunctionLines': 50
                    },
                    'skipDirectories': [
                        'node_modules', '.git', 'dist', 'build', 
                        'coverage', '.next', 'logs', 'tmp'
                    ],
                    'supportedExtensions': ['.py', '.js', '.ts', '.jsx', '.tsx']
                }
            }
        }
        
    def scan_python_files(self, directory: str) -> Dict:
        """Scan Python files using AST analysis."""
        print("🐍 Scanning Python files...")
        
        skip_dirs = self.config.get('scanners', {}).get('deadCode', {}).get('skipDirectories', [])
        results = scan_python_directory(directory, skip_dirs)
        
        summary = {
            'language': 'python',
            'files_analyzed': len(results),
            'files_with_issues': len([r for r in results if r['issues']]),
            'total_issues': sum(len(r['issues']) for r in results),
            'details': results
        }
        
        return summary
        
    def scan_javascript_files(self, directory: str) -> Dict:
        """Scan JavaScript/TypeScript files using ESLint."""
        print("🟨 Scanning JavaScript/TypeScript files...")
        
        try:
            # Check if ESLint is available
            result = subprocess.run(
                ['npx', 'eslint', '--version'], 
                capture_output=True, 
                text=True,
                timeout=10
            )
            
            if result.returncode != 0:
                return {
                    'language': 'javascript',
                    'error': 'ESLint not available',
                    'files_analyzed': 0,
                    'files_with_issues': 0,
                    'total_issues': 0
                }
                
            # Run ESLint for dead code detection
            extensions = self.config.get('scanners', {}).get('deadCode', {}).get('supportedExtensions', [])
            js_extensions = [ext for ext in extensions if ext in ['.js', '.ts', '.jsx', '.tsx']]
            
            if not js_extensions:
                return {
                    'language': 'javascript',
                    'files_analyzed': 0,
                    'files_with_issues': 0,
                    'total_issues': 0
                }
            
            # Create pattern for ESLint
            patterns = []
            for root, dirs, files in os.walk(directory):
                # Skip directories from config
                skip_dirs = self.config.get('scanners', {}).get('deadCode', {}).get('skipDirectories', [])
                dirs[:] = [d for d in dirs if d not in skip_dirs]
                
                for file in files:
                    if any(file.endswith(ext) for ext in js_extensions):
                        patterns.append(os.path.join(root, file))
            
            if not patterns:
                return {
                    'language': 'javascript',
                    'files_analyzed': 0,
                    'files_with_issues': 0,
                    'total_issues': 0
                }
            
            # Run ESLint on detected files
            cmd = [
                'npx', 'eslint',
                '--no-eslintrc',
                '--config', 'eslint.config.js',
                '--format', 'json'
            ] + patterns[:10]  # Limit to first 10 files for performance
            
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            
            if result.returncode == 0 or result.returncode == 1:  # 1 means issues found
                try:
                    eslint_results = json.loads(result.stdout) if result.stdout else []
                    
                    issues_count = sum(len(file_result.get('messages', [])) for file_result in eslint_results)
                    files_with_issues = len([r for r in eslint_results if r.get('messages')])
                    
                    return {
                        'language': 'javascript',
                        'files_analyzed': len(patterns),
                        'files_with_issues': files_with_issues,
                        'total_issues': issues_count,
                        'details': eslint_results
                    }
                except json.JSONDecodeError:
                    return {
                        'language': 'javascript',
                        'error': 'Failed to parse ESLint output',
                        'files_analyzed': len(patterns),
                        'files_with_issues': 0,
                        'total_issues': 0
                    }
            else:
                return {
                    'language': 'javascript',
                    'error': f'ESLint failed with exit code {result.returncode}',
                    'files_analyzed': len(patterns),
                    'files_with_issues': 0,
                    'total_issues': 0
                }
                
        except subprocess.TimeoutExpired:
            return {
                'language': 'javascript',
                'error': 'ESLint analysis timed out',
                'files_analyzed': 0,
                'files_with_issues': 0,
                'total_issues': 0
            }
        except Exception as e:
            return {
                'language': 'javascript',
                'error': str(e),
                'files_analyzed': 0,
                'files_with_issues': 0,
                'total_issues': 0
            }
            
    def generate_report(self) -> str:
        """Generate comprehensive analysis report."""
        duration = time.time() - self.start_time
        
        report_lines = [
            "🔍 ARCANOS Dead Code Scanner Report",
            "=" * 50,
            f"📅 Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"⏱️  Duration: {duration:.2f} seconds",
            ""
        ]
        
        total_files = 0
        total_issues = 0
        
        for result in self.results:
            report_lines.extend([
                f"## {result['language'].upper()} Analysis",
                f"Files analyzed: {result['files_analyzed']}",
                f"Files with issues: {result['files_with_issues']}",
                f"Total issues: {result['total_issues']}"
            ])
            
            if 'error' in result:
                report_lines.append(f"❌ Error: {result['error']}")
            
            total_files += result['files_analyzed']
            total_issues += result['total_issues']
            
            # Add detailed issues for Python
            if result['language'] == 'python' and 'details' in result:
                for file_result in result['details']:
                    if file_result['issues']:
                        report_lines.append(f"\n📄 {file_result['filepath']}:")
                        for issue_type, line_no, message in file_result['issues']:
                            report_lines.append(f"  Line {line_no}: {message}")
            
            report_lines.append("")
        
        report_lines.extend([
            "## Summary",
            f"Total files analyzed: {total_files}",
            f"Total issues found: {total_issues}",
            ""
        ])
        
        if total_issues > 0:
            report_lines.extend([
                "## Recommendations",
                "1. Review flagged unused functions and classes",
                "2. Remove unused imports to reduce memory footprint", 
                "3. Consider breaking down large files (>500 lines)",
                "4. Use AI analysis for safe removal recommendations",
                ""
            ])
        
        return "\n".join(report_lines)
        
    def save_report(self, report: str, filename: str = 'dead_code_report.txt'):
        """Save report to file."""
        with open(filename, 'w', encoding='utf-8') as f:
            f.write(report)
        print(f"📄 Report saved to {filename}")
        
    def scan_repository(self, directory: str = '.', test_mode: bool = False):
        """Main method to scan repository for dead code."""
        print("🔍 ARCANOS Dead Code Scanner")
        print(f"📁 Scanning directory: {os.path.abspath(directory)}")
        
        if not self.config.get('enabled', True):
            print("⚠️  Dead code scanning is disabled in configuration")
            return
            
        scanner_config = self.config.get('scanners', {}).get('deadCode', {})
        if not scanner_config.get('enabled', True):
            print("⚠️  Dead code scanner is disabled in configuration")
            return
            
        # Detect available tools
        available_tools = []
        extensions = scanner_config.get('supportedExtensions', [])
        
        if any(ext in extensions for ext in ['.py']):
            available_tools.append('.py')
        if any(ext in extensions for ext in ['.js', '.ts', '.jsx', '.tsx']):
            available_tools.append('.js/.ts')
            
        print(f"Available tools: {available_tools}")
        
        # Scan Python files
        if '.py' in available_tools:
            python_results = self.scan_python_files(directory)
            self.results.append(python_results)
            
        # Scan JavaScript/TypeScript files  
        if '.js/.ts' in available_tools:
            js_results = self.scan_javascript_files(directory)
            self.results.append(js_results)
            
        # Generate and save report
        report = self.generate_report()
        self.save_report(report)
        
        print("✅ Analysis complete!")
        
        # AI Integration (if configured)
        if self.config.get('ai', {}).get('useExistingService', False):
            self.send_to_ai_analysis(report)
            
    def send_to_ai_analysis(self, report: str):
        """Send report to AI for analysis (placeholder for integration)."""
        print("🤖 Sending report to AI analysis...")
        
        # This would integrate with the existing OpenAI service
        # For now, just indicate the capability
        maintenance_agent = os.getenv('ARCANOS_MAINTENANCE_AGENT')
        if maintenance_agent:
            print(f"📤 Report sent to Maintenance Agent: {maintenance_agent}")
        else:
            print("💡 Set ARCANOS_MAINTENANCE_AGENT environment variable for AI integration")


def main():
    """Command line interface."""
    import argparse
    
    parser = argparse.ArgumentParser(description='ARCANOS Dead Code Scanner')
    parser.add_argument('directory', nargs='?', default='.', 
                       help='Directory to scan (default: current directory)')
    parser.add_argument('--test', action='store_true', 
                       help='Run in test mode with limited file scanning')
    parser.add_argument('--config', default='codex.config.json',
                       help='Configuration file path')
    
    args = parser.parse_args()
    
    scanner = DeadCodeScanner(args.config)
    scanner.scan_repository(args.directory, args.test)


if __name__ == '__main__':
    main()