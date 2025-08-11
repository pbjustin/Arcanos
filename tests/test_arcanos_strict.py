#!/usr/bin/env python3
"""
Test suite for ARCANOS Strict GPT-5 Module

Tests the strict GPT-5 enforcement and maintenance agent alerting functionality.
"""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock
import tempfile

# Add the parent directory to sys.path to import arcanos_strict
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    import arcanos_strict
except ImportError as e:
    print(f"Failed to import arcanos_strict: {e}")
    sys.exit(1)

class TestArcanosStrict(unittest.TestCase):
    """Test cases for the ARCANOS strict module."""

    def setUp(self):
        """Set up test fixtures."""
        self.test_prompt = "Test ARCANOS reasoning prompt"
        self.expected_model = "ft:your-arcanos-finetune-id"
        
    @patch('arcanos_strict.client.chat.completions.create')
    @patch('arcanos_strict.alert_maintenance_agent')
    def test_call_arcanos_strict_success(self, mock_alert, mock_create):
        """Test successful ARCANOS strict call."""
        # Mock successful response with correct model
        mock_response = MagicMock()
        mock_response.model = self.expected_model
        mock_create.return_value = mock_response
        
        result = arcanos_strict.call_arcanos_strict(self.test_prompt)
        
        # Verify the call was made with correct parameters
        mock_create.assert_called_once_with(
            model=self.expected_model,
            messages=[{"role": "user", "content": self.test_prompt}]
        )
        
        # Verify no alert was sent
        mock_alert.assert_not_called()
        
        # Verify correct response returned
        self.assertEqual(result, mock_response)

    @patch('arcanos_strict.client.chat.completions.create')
    @patch('arcanos_strict.alert_maintenance_agent')
    def test_call_arcanos_strict_wrong_model(self, mock_alert, mock_create):
        """Test ARCANOS strict call with wrong model response."""
        # Mock response with wrong model
        mock_response = MagicMock()
        mock_response.model = "gpt-4"  # Wrong model
        mock_create.return_value = mock_response
        
        with self.assertRaises(RuntimeError) as context:
            arcanos_strict.call_arcanos_strict(self.test_prompt)
        
        # Verify error message
        self.assertIn("Unexpected model used: gpt-4", str(context.exception))
        
        # Verify maintenance agent was alerted
        mock_alert.assert_called_once()
        alert_message = mock_alert.call_args[0][0]
        self.assertIn("Strict lock failure", alert_message)

    @patch('arcanos_strict.client.chat.completions.create')
    @patch('arcanos_strict.alert_maintenance_agent')
    def test_call_arcanos_strict_api_error(self, mock_alert, mock_create):
        """Test ARCANOS strict call with API error."""
        # Mock API error
        mock_create.side_effect = Exception("API Error")
        
        with self.assertRaises(Exception) as context:
            arcanos_strict.call_arcanos_strict(self.test_prompt)
        
        # Verify error propagated
        self.assertEqual(str(context.exception), "API Error")
        
        # Verify maintenance agent was alerted
        mock_alert.assert_called_once()
        alert_message = mock_alert.call_args[0][0]
        self.assertIn("Strict lock failure", alert_message)

    @patch('arcanos_strict.client.beta.threads.runs.create')
    @patch('arcanos_strict.client.beta.threads.messages.create')
    @patch('arcanos_strict.client.beta.threads.create')
    def test_alert_maintenance_agent_success(self, mock_thread_create, mock_message_create, mock_run_create):
        """Test successful maintenance agent alert."""
        # Mock thread creation
        mock_thread = MagicMock()
        mock_thread.id = "thread_123"
        mock_thread_create.return_value = mock_thread
        
        test_message = "Test alert message"
        
        arcanos_strict.alert_maintenance_agent(test_message)
        
        # Verify thread was created
        mock_thread_create.assert_called_once()
        
        # Verify message was added
        mock_message_create.assert_called_once_with(
            thread_id="thread_123",
            role="user",
            content=test_message
        )
        
        # Verify run was created with maintenance agent
        mock_run_create.assert_called_once_with(
            thread_id="thread_123",
            assistant_id="asst_LhMO3urEF0nBqph5bA65MMu"
        )

    @patch('arcanos_strict.client.beta.threads.create')
    @patch('builtins.print')
    def test_alert_maintenance_agent_failure(self, mock_print, mock_create):
        """Test maintenance agent alert with API error."""
        # Mock API error
        mock_create.side_effect = Exception("Assistant API Error")
        test_message = "Test alert message"
        
        # Should not raise exception, just print error
        arcanos_strict.alert_maintenance_agent(test_message)
        
        # Verify error was printed
        mock_print.assert_called_once()
        print_args = mock_print.call_args[0][0]
        self.assertIn("Failed to alert Maintenance Agent", print_args)
        self.assertIn("Assistant API Error", print_args)

    def test_module_constants(self):
        """Test that module constants are correctly defined."""
        self.assertEqual(arcanos_strict.ARCANOS_FINE_TUNE_ID, "ft:your-arcanos-finetune-id")

    @patch('arcanos_strict.client.chat.completions.create')
    @patch('arcanos_strict.alert_maintenance_agent')
    def test_call_arcanos_strict_with_kwargs(self, mock_alert, mock_create):
        """Test ARCANOS strict call with additional kwargs."""
        # Mock successful response
        mock_response = MagicMock()
        mock_response.model = self.expected_model
        mock_create.return_value = mock_response
        
        # Call with additional parameters
        kwargs = {"temperature": 0.5, "max_tokens": 100}
        result = arcanos_strict.call_arcanos_strict(self.test_prompt, **kwargs)
        
        # Verify the call included kwargs
        mock_create.assert_called_once_with(
            model=self.expected_model,
            messages=[{"role": "user", "content": self.test_prompt}],
            **kwargs
        )

class TestEnvironmentSetup(unittest.TestCase):
    """Test environment setup and configuration."""

    def test_openai_import(self):
        """Test that openai module is available."""
        try:
            from openai import OpenAI
        except ImportError:
            self.fail("openai module not available - install with: pip install openai")

    def test_module_structure(self):
        """Test that the module has required functions."""
        self.assertTrue(hasattr(arcanos_strict, 'call_arcanos_strict'))
        self.assertTrue(hasattr(arcanos_strict, 'alert_maintenance_agent'))
        self.assertTrue(hasattr(arcanos_strict, 'ARCANOS_FINE_TUNE_ID'))

if __name__ == '__main__':
    print("Running ARCANOS Strict GPT-5 Module Tests")
    print("=" * 50)
    
    # Run the tests
    unittest.main(verbosity=2)