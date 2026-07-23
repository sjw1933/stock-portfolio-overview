import type { Currency } from '../types';

export const rates: Record<Currency, number> = { HKD: 1, USD: 7.82, CNY: 1.09 };
export const currencyMarks: Record<Currency, string> = { HKD: 'HK$', USD: '$', CNY: '¥' };

export function convert(amount: number, from: 'USD' | 'HKD', to: Currency) {
  const hkd = from === 'USD' ? amount * rates.USD : amount;
  return hkd / rates[to];
}

export function money(amount: number, currency: Currency, masked: boolean) {
  if (masked) return `${currencyMarks[currency]} ****`;
  return `${currencyMarks[currency]} ${amount.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}

export function signed(amount: number, currency: Currency, masked: boolean) {
  if (masked) return `${currencyMarks[currency]} ****`;
  const prefix = amount >= 0 ? '+' : '-';
  return `${prefix}${currencyMarks[currency]} ${Math.abs(amount).toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;
}
