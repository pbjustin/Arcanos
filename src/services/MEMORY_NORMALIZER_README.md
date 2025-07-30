# Memory Write + Index Normalizer

This module provides automatic memory indexing with normalized aliases for efficient topic-based memory retrieval.

## Features

- **Automatic alias generation**: Converts topics into multiple searchable formats
- **Special game aliases**: Recognizes "baldur" games and generates "bg3" aliases
- **Transparent indexing**: Stores memory and creates alias indexes automatically

## Usage

```typescript
import { storeMemoryWithIndex, normalizeAliases } from './src/services/memory-normalizer';

// Store memory with automatic indexing
await storeMemoryWithIndex('game_guide_combat', {
  topic: 'baldurs gate 3',
  content: 'Combat mechanics and strategies',
  difficulty: 'intermediate'
});

// This automatically creates alias indexes:
// - alias_index/baldurs gate 3 → game_guide_combat
// - alias_index/baldurs_gate_3 → game_guide_combat  
// - alias_index/baldurs-gate-3 → game_guide_combat
// - alias_index/bg3 → game_guide_combat
// - alias_index/baldurs_gate → game_guide_combat
```

## Example Output

```
'baldurs gate 3' → ['baldurs gate 3', 'baldurs_gate_3', 'baldurs-gate-3', 'bg3', 'baldurs_gate']
'hello world' → ['hello world', 'hello_world', 'hello-world']
'simple' → ['simple']
```

## Implementation Details

- Uses existing memory service functions `writeMemory` and `indexMemory`
- Falls back to using the key as topic if `payload.topic` is not provided
- Creates indexed entries with format `alias_index/{alias}` pointing to the original key
- Handles case-insensitive normalization
- Special handling for Baldur's Gate games with "bg3" shorthand

## API Reference

### `storeMemoryWithIndex(key: string, payload: any): Promise<void>`
Stores memory and automatically creates alias indexes based on the topic.

### `normalizeAliases(topic: string): string[]`
Generates normalized aliases for a given topic string.