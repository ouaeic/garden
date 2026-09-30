import { describe, expect, it } from 'vitest';
import { makerOf, providerOf, routeCount, routeOf } from './model-makers.js';

const custom = (connection: string, model: string, connectionLabel?: string) => ({
  id: `custom/${connection}/${encodeURIComponent(model)}`,
  displayName: model,
  provider: 'custom' as const,
  ...(connectionLabel ? { connectionLabel } : {})
});

describe('who made a model and how it arrives', () => {
  it('puts the same model from two connections under one maker with two routes', () => {
    const models = [
      {
        id: 'openrouter/anthropic/claude-sonnet',
        displayName: 'Claude Sonnet',
        provider: 'openrouter' as const
      },
      custom('openai-compatible:1', 'claude-sonnet', 'Anthropic')
    ];
    expect(models.map(makerOf)).toEqual(['Anthropic', 'Anthropic']);
    expect(models.map(routeOf)).toEqual(['OpenRouter', 'Anthropic']);
    expect(routeCount(models)).toBe(2);
  });

  it('keeps model makers and account labels out of service identity', () => {
    const models = [
      {
        ...custom('ollama-cloud', 'deepseek-v4.1-flash', 'Research'),
        connectionProvider: 'Ollama Cloud'
      },
      { ...custom('ollama-cloud', 'qwen3', 'Work'), connectionProvider: 'Ollama Cloud' },
      { id: 'openrouter/deepseek/flash', displayName: 'Flash', provider: 'openrouter' }
    ];
    expect(models.map(providerOf)).toEqual(['Ollama Cloud', 'Ollama Cloud', 'OpenRouter']);
    expect(models.map(routeOf)).toEqual([
      'Ollama Cloud · Research',
      'Ollama Cloud · Work',
      'OpenRouter'
    ]);
    expect(models.map(makerOf)).toEqual(['DeepSeek', 'Qwen', 'DeepSeek']);
  });

  it('reads the maker from the family name a direct endpoint lists', () => {
    const cases: Array<[string, string]> = [
      ['gpt-5', 'OpenAI'],
      ['o4-mini', 'OpenAI'],
      ['gemini-2.5-pro', 'Google'],
      ['grok-4', 'xAI'],
      ['codestral-latest', 'Mistral'],
      ['deepseek-chat', 'DeepSeek'],
      ['kimi-k2', 'Moonshot AI'],
      ['meta-llama/Llama-3.3-70B-Instruct', 'Meta'],
      ['accounts/fireworks/models/qwen3-coder', 'Qwen']
    ];
    for (const [model, maker] of cases)
      expect(makerOf(custom('openai-compatible:2', model, 'Direct')), model).toBe(maker);
  });

  it('falls back to the connection when the name says nothing about its maker', () => {
    const model = custom('openai-compatible:3', 'house-model', 'Work');
    expect(makerOf(model)).toBe('Work');
    expect(routeCount([model])).toBe(1);
  });
});
