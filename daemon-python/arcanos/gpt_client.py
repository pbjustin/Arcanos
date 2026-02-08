"""
OpenAI GPT Client with Rate Limiting and Error Handling
Handles all OpenAI API interactions with retry logic and caching.
"""

import time
from typing import Optional, Dict, Any, Union, Generator
from openai import OpenAIError, APIError, RateLimitError, APIConnectionError, AuthenticationError, BadRequestError, NotFoundError
from tenacity import retry, stop_after_attempt, wait_exponential, retry_if_exception_type
from .config import Config
from .openai.unified_client import get_or_create_client
from .openai.openai_adapter import chat_completion, chat_stream, transcribe, vision_completion

# OpenAI pricing per token (USD)
GPT4O_MINI_INPUT_COST = 0.15 / 1_000_000
GPT4O_MINI_OUTPUT_COST = 0.60 / 1_000_000
GPT4O_INPUT_COST = 5.00 / 1_000_000
GPT4O_OUTPUT_COST = 15.00 / 1_000_000


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
        #audit Assumption: non-mock mode requires unified client availability before serving requests; risk: deferred runtime failures per call; invariant: readiness checked at initialization; handling: fail fast if client singleton cannot initialize.
        if not self.is_mock and not get_or_create_client(Config):
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

            # Make API call through canonical adapter surface
            response = chat_completion(
                user_message=user_message,
                system_prompt=system_prompt,
                temperature=temperature or Config.TEMPERATURE,
                max_tokens=max_tokens or Config.MAX_TOKENS,
                conversation_history=conversation_history,
                model=Config.OPENAI_MODEL,
            )

            # Extract response
            response_text = response.choices[0].message.content
            tokens_used = response.usage.total_tokens

            input_tokens = response.usage.prompt_tokens
            output_tokens = response.usage.completion_tokens
            cost = (input_tokens * GPT4O_MINI_INPUT_COST) + (output_tokens * GPT4O_MINI_OUTPUT_COST)

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
    ) -> Generator[Union[str, Any], None, None]:
        """
        Stream a response from GPT, yielding text chunks and a final usage object.
        
        Yields:
            str: Text content deltas as they arrive
            Usage object: Final chunk with token usage statistics (has .total_tokens, 
                         .prompt_tokens, .completion_tokens attributes)
        """
        try:
            stream = chat_stream(
                user_message=user_message,
                system_prompt=system_prompt,
                temperature=temperature or Config.TEMPERATURE,
                max_tokens=max_tokens or Config.MAX_TOKENS,
                conversation_history=conversation_history,
                model=Config.OPENAI_MODEL,
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
            response = vision_completion(
                user_message=user_message,
                image_base64=image_base64,
                temperature=temperature or Config.TEMPERATURE,
                max_tokens=max_tokens or Config.MAX_TOKENS,
                model=Config.OPENAI_VISION_MODEL,
            )

            response_text = response.choices[0].message.content
            tokens_used = response.usage.total_tokens

            input_tokens = response.usage.prompt_tokens
            output_tokens = response.usage.completion_tokens
            cost = (input_tokens * GPT4O_INPUT_COST) + (output_tokens * GPT4O_OUTPUT_COST)

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
            response = transcribe(
                audio_bytes=audio_bytes,
                filename=filename,
                model=Config.OPENAI_TRANSCRIBE_MODEL,
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

