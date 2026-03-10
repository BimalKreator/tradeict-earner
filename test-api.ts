import { getBinanceBalance, getBybitBalance } from './lib/trading-engine/execution-engine';

async function test() {
    const keys = JSON.parse(localStorage.getItem('tradeict-earner-settings') || '{}');
    // Note: Terminal mein localStorage nahi hota, isliye yahan direct keys dal kar check karein
    const binance = await getBinanceBalance('YOUR_BINANCE_KEY', 'YOUR_BINANCE_SECRET');
    const bybit = await getBybitBalance('YOUR_BYBIT_KEY', 'YOUR_BYBIT_SECRET');
    console.log('Binance Balance:', binance);
    console.log('Bybit Balance:', bybit);
}
test();
