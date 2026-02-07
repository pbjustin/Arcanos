"""
OpenAI GPT Client with Rate Limiting and Error Handling
Handles all OpenAI API interactions with retry logic and caching.
"""

import time
from io import BytesIO
from typing import Optional, Dict, Any
from openai import OpenAIError, APIError, RateLimitError, APIConnectionError, AuthenticationError, BadRequestError, NotFoundError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from .config import Config
from .openai.unified_client import get_or_create_client


def _is_mock_api_key(api_key: str) -> bool:
    normalized = api_key.strip().lower()
    return normalized in {"mock", "mock-api-key", "test", "test-key", "fake"} or normalized.startswith("mock-")


def _mock_return_for(kind: str):
    """Return the appropriate mock value for ask/ask_stream/ask_with_vision/transcribe_audio when is_mock."""
    if kind == "chat":
        return ("Mock response: API key is in mock mode.", 0, 0.0)
    if kind == "stream":
        def _gen():
            for c in ["Mock ", "response: ", "API key ", "is in ", "mock mode."]:
                yield c
        return _gen()
    if kind == "vision":
        return ("Mock vision response: API key is in mock mode.", 0, 0.0)
    if kind == "transcribe":
        return "Mock transcription: API key is in mock mode."
    raise ValueError(f"Unknown mock kind: {kind}")


def _no_network_if_mock(kind: str):
    """Decorator: if self.is_mock, return mock value and skip network; else call the real method."""
    def decorator(f):
        def wrapper(self, *args, **kwargs):
            if self.is_mock:
                return _mock_return_for(kind)
            return f(self, *args, **kwargs)
        return wrapper
    return decorator


class GPTClient:
    """OpenAI API client with built-in rate limiting and error handling"""

    def __init__(self, api_key: Optional[str] = None):
        """
        Initialize GPT client using unified_client adapter.
        
        Args:
            api_key: Optional API key override. If None, uses Config.OPENAI_API_KEY via unified_client.
        """
        self.api_key = api_key or Config.OPENAI_API_KEY
        if not self.api_key:
            raise ValueError("OpenAI API key is required")

        self.is_mock = _is_mock_api_key(self.api_key)
        # Use unified_client adapter instead of direct OpenAI construction
        # This enforces the adapter boundary pattern
        self.client = None if self.is_mock else get_or_create_client(Config)
        if not self.is_mock and not self.client:
            raise RuntimeError("Failed to initialize OpenAI client via unified_client adapter")
        self._request_cache: Dict[str, tuple[str, float]] = {}
        self._cache_ttl = 300  # 5 minutes

    @retry(
        retry=retry_if_exception_type((RateLimitError, APIConnectionError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    @_no_network_if_mock("chat")
    def ask(
        self,
        user_message: str,
        system_prompt: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        conversation_history: Optional[list] = None
    ) -> tuple[str, int, float]:
        """
        Send a message to GPT and get response
        Returns: (response_text, tokens_used, cost)
        """
        try:
            # Build messages
            messages = []

            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})

            # Add conversation history
            if conversation_history:
                for conv in conversation_history[-5:]:  # Last 5 conversations for context
                    messages.append({"role": "user", "content": conv["user"]})
                    messages.append({"role": "assistant", "content": conv["ai"]})

            messages.append({"role": "user", "content": user_message})

            # Check cache
            cache_key = str(messages)
            if cache_key in self._request_cache:
                cached_response, cached_time = self._request_cache[cache_key]
                if time.time() - cached_time < self._cache_ttl:
                    return cached_response, 0, 0.0

            # Make API call
            response = self.client.chat.completions.create(
                model=Config.OPENAI_MODEL,
                messages=messages,
                temperature=temperature or Config.TEMPERATURE,
                max_tokens=max_tokens or Config.MAX_TOKENS,
                timeout=Config.REQUEST_TIMEOUT
            )

            # Extract response
            response_text = response.choices[0].message.content
            tokens_used = response.usage.total_tokens

            # Calculate cost (GPT-4o Mini: $0.15/1M input, $0.60/1M output)
            input_tokens = response.usage.prompt_tokens
            output_tokens = response.usage.completion_tokens
            cost = (input_tokens * 0.15 / 1_000_000) + (output_tokens * 0.60 / 1_000_000)

            # Cache response
            self._request_cache[cache_key] = (response_text, time.time())

            return response_text, tokens_used, cost

        except AuthenticationError:
            raise ValueError("Invalid OpenAI API key. Check your .env file.")
        except RateLimitError:
            raise RuntimeError("OpenAI rate limit exceeded. Please try again later.")
        except APIConnectionError:
            raise ConnectionError("Failed to connect to OpenAI. Check your internet connection.")
        except BadRequestError as e:
            raise ValueError(f"Invalid request to OpenAI: {str(e)}")
        except NotFoundError:
            raise ValueError(f"Model '{Config.OPENAI_MODEL}' not found. Check your configuration.")
        except APIError as e:
            raise RuntimeError(f"OpenAI API error: {str(e)}")
        except OpenAIError as e:
            raise RuntimeError(f"OpenAI error: {str(e)}")
        except Exception as e:
            raise RuntimeError(f"Unexpected error calling GPT: {str(e)}")

    @retry(
        retry=retry_if_exception_type((RateLimitError, APIConnectionError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    @_no_network_if_mock("stream")
    def ask_stream(
        self,
        user_message: str,
        system_prompt: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        conversation_history: Optional[list] = None
    ):
        """
        Stream a response from GPT, yielding text chunks.
        """
        try:
            messages = []

            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})

            if conversation_history:
                for conv in conversation_history[-5:]:
                    messages.append({"role": "user", "content": conv["user"]})
                    messages.append({"role": "assistant", "content": conv["ai"]})

            messages.append({"role": "user", "content": user_message})

            stream = self.client.chat.completions.create(
                model=Config.OPENAI_MODEL,
                messages=messages,
                temperature=temperature or Config.TEMPERATURE,
                max_tokens=max_tokens or Config.MAX_TOKENS,
                timeout=Config.REQUEST_TIMEOUT,
                stream=True,
                stream_options={"include_usage": True},
            )

            for chunk in stream:
                if chunk.choices:
                    delta = chunk.choices[0].delta.content
                    if delta:
                        yield delta
                # Final chunk carries usage stats (no choices)
                if chunk.usage:
                    yield chunk.usage

        except AuthenticationError:
            raise ValueError("Invalid OpenAI API key. Check your .env file.")
        except RateLimitError:
            raise RuntimeError("OpenAI rate limit exceeded. Please try again later.")
        except APIConnectionError:
            raise ConnectionError("Failed to connect to OpenAI. Check your internet connection.")
        except BadRequestError as e:
            raise ValueError(f"Invalid request to OpenAI: {str(e)}")
        except NotFoundError:
            raise ValueError(f"Model '{Config.OPENAI_MODEL}' not found. Check your configuration.")
        except APIError as e:
            raise RuntimeError(f"OpenAI API error: {str(e)}")
        except OpenAIError as e:
            raise RuntimeError(f"OpenAI error: {str(e)}")
        except Exception as e:
            raise RuntimeError(f"Unexpected error calling GPT: {str(e)}")

    @retry(
        retry=retry_if_exception_type((RateLimitError, APIConnectionError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    @_no_network_if_mock("vision")
    def ask_with_vision(
        self,
        user_message: str,
        image_base64: str,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None
    ) -> tuple[str, int, float]:
        """
        Send a message with an image to GPT-4o Vision
        Returns: (response_text, tokens_used, cost)
        """
        try:
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_message},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/png;base64,{image_base64}",
                                "detail": "auto"
                            }
                        }
                    ]
                }
            ]

            response = self.client.chat.completions.create(
                model=Config.OPENAI_VISION_MODEL,
                messages=messages,
                temperature=temperature or Config.TEMPERATURE,
                max_tokens=max_tokens or Config.MAX_TOKENS,
                timeout=Config.REQUEST_TIMEOUT
            )

            response_text = response.choices[0].message.content
            tokens_used = response.usage.total_tokens

            # Calculate cost (GPT-4o: $2.50/1M input, $10.00/1M output)
            input_tokens = response.usage.prompt_tokens
            output_tokens = response.usage.completion_tokens
            cost = (input_tokens * 2.50 / 1_000_000) + (output_tokens * 10.00 / 1_000_000)

            return response_text, tokens_used, cost

        except AuthenticationError:
            raise ValueError("Invalid OpenAI API key. Check your .env file.")
        except RateLimitError:
            raise RuntimeError("OpenAI rate limit exceeded. Please try again later.")
        except APIConnectionError:
            raise ConnectionError("Failed to connect to OpenAI. Check your internet connection.")
        except BadRequestError as e:
            raise ValueError(f"Invalid vision request: {str(e)}")
        except NotFoundError:
            raise ValueError(f"Vision model '{Config.OPENAI_VISION_MODEL}' not found.")
        except APIError as e:
            raise RuntimeError(f"OpenAI API error: {str(e)}")
        except OpenAIError as e:
            raise RuntimeError(f"OpenAI error: {str(e)}")
        except Exception as e:
            raise RuntimeError(f"Unexpected error in vision request: {str(e)}")

    def clear_cache(self) -> None:
        """Clear the response cache"""
        self._request_cache.clear()

    @retry(
        retry=retry_if_exception_type((RateLimitError, APIConnectionError)),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=1, min=2, max=10)
    )
    @_no_network_if_mock("transcribe")
    def transcribe_audio(self, audio_bytes: bytes, filename: str = "speech.wav") -> str:
        """
        Transcribe audio bytes using OpenAI
        Returns: transcribed text
        """
        try:
            audio_file = BytesIO(audio_bytes)
            audio_file.name = filename

            response = self.client.audio.transcriptions.create(
                model=Config.OPENAI_TRANSCRIBE_MODEL,
                file=audio_file,
                timeout=Config.REQUEST_TIMEOUT
            )

            if isinstance(response, str):
                return response
            return response.text

        except AuthenticationError:
            raise ValueError("Invalid OpenAI API key. Check your .env file.")
        except RateLimitError:
            raise RuntimeError("OpenAI rate limit exceeded. Please try again later.")
        except APIConnectionError:
            raise ConnectionError("Failed to connect to OpenAI. Check your internet connection.")
        except BadRequestError as e:
            raise ValueError(f"Invalid transcription request: {str(e)}")
        except NotFoundError:
            raise ValueError(f"Transcription model '{Config.OPENAI_TRANSCRIBE_MODEL}' not found.")
        except APIError as e:
            raise RuntimeError(f"OpenAI API error: {str(e)}")
        except OpenAIError as e:
            raise RuntimeError(f"OpenAI error: {str(e)}")
        except Exception as e:
            raise RuntimeError(f"Unexpected error in transcription: {str(e)}")

