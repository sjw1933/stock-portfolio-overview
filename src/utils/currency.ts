import type { Currency, HoldingCurrency, Market } from '../types';

/** HKD value of 1 unit of each currency (approximate board rates). */
export const rates: Record<Currency, number> = { HKD: 1, USD: 7.82, CNY: 1.09 };
export const currencyMarks: Record<Currency, string> = { HKD: 'HK$', USD: '$', CNY: '¥' };

export function convert(amount: number, from: HoldingCurrency | Currency, to: Currency) {
  const fromRate = rates[from as Currency] ?? rates.HKD;
  return (amount * fromRate) / rates[to];
}

export function currencyForMarket(market: Market): HoldingCurrency {
  if (market === 'HK') return 'HKD';
  if (market === 'CN') return 'CNY';
  return 'USD';
}

export function marketLabel(market: Market) {
  if (market === 'HK') return '港股';
  if (market === 'CN') return '大A';
  return '美股';
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
