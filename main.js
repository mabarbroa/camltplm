import 'dotenv/config';
import { readFileSync } from 'fs';
import { ethers } from 'ethers';

// ======== CONFIG ========
const RPC = process.env.PLUME_RPC?.trim() || 'https://phoenix-rpc.plumenetwork.xyz'; // Plume RPC
const CHAIN_ID = 98866;

// Addresses (Camelot Plume)
const ROUTER_V2 = '0x10aA510d94E094Bd643677bd2964c3EE085Daffc';
const WPLUME   = '0xEa237441c92CAe6FC17Caaf9a7acB3f953be4bd1';
const PUSD     = '0xdddD73F5Df1F0DC31373357beAC77545dC5A6f3F';

// Amount control
// Pakai salah satu: AMOUNT_PLUME atau MIN_PLUME..MAX_PLUME (random)
const AMOUNT_PLUME = process.env.AMOUNT_PLUME ? Number(process.env.AMOUNT_PLUME) : null; // mis. 0.02
const MIN_PLUME    = process.env.MIN_PLUME ? Number(process.env.MIN_PLUME) : 0.01;
const MAX_PLUME    = process.env.MAX_PLUME ? Number(process.env.MAX_PLUME) : 0.02;

// Slippage (persen)
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 100; // 1%
// Deadline (menit)
const DEADLINE_MIN = process.env.DEADLINE_MIN ? Number(process.env.DEADLINE_MIN) : 15;

// Delay antar swap (detik)
const DELAY_MIN_S = 5;
const DELAY_MAX_S = 20;

// ======== ABIs ========
const ROUTER_V2_ABI = [
  // read
  'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
  // write
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pickAmount() {
  if (AMOUNT_PLUME && AMOUNT_PLUME > 0) return AMOUNT_PLUME;
  const f = rand(Math.round(MIN_PLUME * 1e6), Math.round(MAX_PLUME * 1e6)) / 1e6;
  return Number(f.toFixed(6));
}
function normPK(line) {
  const t = line.trim();
  if (!t) return null;
  return t.startsWith('0x') ? t : '0x' + t;
}

async function swapOneWallet(pk, provider) {
  const wallet = new ethers.Wallet(pk, provider);
  const router = new ethers.Contract(ROUTER_V2, ROUTER_V2_ABI, wallet);

  // cek chainId
  const { chainId } = await provider.getNetwork();
  if (Number(chainId) !== CHAIN_ID) {
    throw new Error(`Wrong chainId: got ${chainId}, expected ${CHAIN_ID}`);
  }

  // amount & path
  const amountInEth = pickAmount();
  const value = ethers.parseEther(amountInEth.toString());
  const path = [WPLUME, PUSD];

  // cek saldo native
  const bal = await provider.getBalance(wallet.address);
  if (bal < value) {
    console.log(`  ✖ ${wallet.address} saldo kurang. Balance: ${ethers.formatEther(bal)} PLUME`);
    return;
  }

  // estimasi out + slippage
  const amounts = await router.getAmountsOut(value, path);
  const outNoSlip = amounts[amounts.length - 1];
  const minOut = outNoSlip - (outNoSlip * BigInt(SLIPPAGE_BPS)) / 10000n;

  const deadline = Math.floor(Date.now() / 1000) + DEADLINE_MIN * 60;

  console.log(`  → Swap ${amountInEth} PLUME ⇒ pUSD (minOut ≈ ${ethers.formatUnits(minOut, 18)} pUSD)`);

  const tx = await router.swapExactETHForTokens(
    minOut,
    path,
    wallet.address,
    deadline,
    { value }
  );
  console.log(`    ⛓️  Tx sent: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`    ✅ Confirmed in block ${rc.blockNumber}`);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

  // baca account.txt (1 pk per baris, boleh tanpa 0x)
  const lines = readFileSync('account.txt', 'utf8').split(/\r?\n/).map(normPK).filter(Boolean);
  if (lines.length === 0) throw new Error('account.txt kosong');

  console.log(`=== Camelot Auto Swap (Plume ➜ pUSD) ===
RPC        : ${RPC}
Wallets    : ${lines.length}
Router V2  : ${ROUTER_V2}
Path       : WPLUME -> pUSD
Slippage   : ${(SLIPPAGE_BPS/100).toFixed(2)}%
`);

  for (let i = 0; i < lines.length; i++) {
    console.log(`[${i+1}/${lines.length}] Wallet: ${new ethers.Wallet(lines[i]).address}`);
    try {
      await swapOneWallet(lines[i], provider);
    } catch (e) {
      console.error('  ❗ Error:', e.message);
    }
    const delayS = rand(DELAY_MIN_S, DELAY_MAX_S);
    console.log(`  … delay ${delayS}s\n`);
    await sleep(delayS * 1000);
  }

  console.log('=== Selesai ===');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
