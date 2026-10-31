import type { Preset } from './types.js';
import { DEFAULT_SETTINGS } from './types.js';

const withSettings = (overrides: Partial<typeof DEFAULT_SETTINGS>): typeof DEFAULT_SETTINGS => ({ ...DEFAULT_SETTINGS, ...overrides });

export function defaultPresets(): Preset[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'default-website-images',
      name: 'Website Images',
      description: 'Balanced same-format optimization for everyday web assets.',
      settings: withSettings({ profile: 'balanced', outputPolicy: 'preserve', quality: 'auto' }),
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'default-product-photos',
      name: 'Product Photos',
      description: 'Fidelity-first quality selection for product photography.',
      settings: withSettings({ profile: 'maximum', outputPolicy: 'preserve', quality: 'auto' }),
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'default-graphics',
      name: 'Graphics & Illustrations',
      description: 'Preserves format and favors crisp edges, colors, and transparency.',
      settings: withSettings({ profile: 'balanced', outputPolicy: 'preserve', lossless: true }),
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'default-screenshots',
      name: 'Screenshots',
      description: 'Conservative settings for text-heavy UI images and gradients.',
      settings: withSettings({ profile: 'maximum', outputPolicy: 'preserve', quality: 'auto', metadata: 'strip' }),
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'default-logos',
      name: 'Logos',
      description: 'Lossless by default where the source format supports it.',
      settings: withSettings({ profile: 'balanced', outputPolicy: 'preserve', quality: 'auto', lossless: true }),
      builtIn: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}
