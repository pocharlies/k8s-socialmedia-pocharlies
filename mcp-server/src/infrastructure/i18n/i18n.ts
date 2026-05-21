import i18next from 'i18next';
import { readFileSync } from 'fs';
import { join } from 'path';

const localesPath = join(__dirname, '../../locales');

const enTranslations = JSON.parse(readFileSync(join(localesPath, 'en.json'), 'utf-8'));
const esTranslations = JSON.parse(readFileSync(join(localesPath, 'es.json'), 'utf-8'));

i18next.init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: { translation: enTranslations },
    es: { translation: esTranslations },
  },
  interpolation: {
    escapeValue: false,
  },
});

export default i18next;

export function t(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

export function changeLanguage(lng: 'en' | 'es'): void {
  i18next.changeLanguage(lng);
}
