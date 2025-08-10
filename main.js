// main.js — Rooster Auto Swap PLUME -> pUSD (Plume Mainnet 98866)
// Node 18+, ESM. Pastikan package.json ada: { "type": "module" }
import 'dotenv/config';
import { readFileSync } from 'fs';
import { setTimeout as wait } from 'timers/promises';
import { ethers } from 'ethers';

// ======== ENV & Default ========
const {
  PLUME_RPC = 'https://rpc.plume.org',
  LOOPS = '1',
  DELAY_MIN_SEC = '5',
  DELAY_MAX_SEC = '20',
  SLIPPAGE_PERCENT = '0.7',
  GAS_RESERVE_PLUME = '0.005',

  // Versi fix: default pakai range 0.5–1 PLUME
  AMOUNT_MODE = 'range',      // 'range' | 'fixed' | 'percent' | 'all'
  MIN_PLUME = '0.5',          // dipakai saat AMOUNT_MODE=range
  MAX_PLUME = '1',
  FIXED_PLUME = '0.01',       // fallback jika AMOUNT_MODE='fixed'
  PERCENT_BALANCE = '50'      // fallback jika AMOUNT_MODE='percent'
} = process.env;

// ======== Konstanta Plume ========
const CHAIN_ID = 98866;
const ZERO = '0x0000000000000000000000000000000000000000'; // native PLUME
const PUSD = '0xdddD73F5Df1F0DC31373357beAC77545dC5A6f3F';

// Rooster API
const CALLDATA_API = 'https://api.rooster-protocol.xyz/api/swap/callData';

// ======== Provider ========
const provider = new ethers.JsonRpcProvider(PLUME_RPC, {
  chainId: CHAIN_ID,
  name: 'plume',
});

// ======== Utils ========
function readPrivateKeys(path = 'account.txt') {
  const raw = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  return raw;
}
function randInt(min, max) {
  const a = Math.ceil(min), b = Math.floor(max);
  return Math.floor(Math.random() * (b - a + 1)) + a;
}
function randFloat(min, max, dp = 6) {
  const v = Math.random() * (max - min) + min;
  return Number(v.toFixed(dp));
}
async function delayRandom() {
  const sec = randInt(Number(DELAY_MIN_SEC), Number(DELAY_MAX_SEC));
  console.log(`  … delay ${sec}s`);
  await wait(sec * 1000);
}
async function ensureChain() {
  const nw = await provider.getNetwork();
  const cid = Number(nw.chainId);
  if (cid !== CHAIN_ID) {
    throw new Error(`Salah network. Dapat: ${cid}, harus ${CHAIN_ID} (Plume mainnet)`);
  }
}

// ======== Penentuan Amount ========
function pickAmountWei(balanceWei) {
  const reserve = ethers.parseEther(GAS_RESERVE_PLUME);
  const avail = balanceWei > reserve ? (balanceWei - reserve) : 0n;
  if (avail <= 0n) return 0n;

  if (AMOUNT_MODE === 'all') return avail;

  if (AMOUNT_MODE === 'percent') {
    const pct = Math.max(0, Math.min(100, Number(PERCENT_BALANCE)));
    const wei = (avail * BigInt(Math.floor(pct * 100))) / 10000n;
    return wei <= 0n ? 0n : wei;
  }

  if (AMOUNT_MODE === 'range') {
    const minP = Math.max(0, Number(MIN_PLUME));
    const maxP = Math.max(minP, Number(MAX_PLUME));
    const pick = randFloat(minP, maxP, 6);
    let wei = ethers.parseEther(String(pick));
    if (wei > avail) wei = avail; // clamp kalau saldo kurang
    return wei <= 0n ? 0n : wei;
  }

  // default 'fixed'
  let fixed = ethers.parseEther(FIXED_PLUME);
  if (fixed > avail) fixed = avail;
  return fixed <= 0n ? 0n : fixed;
}

// ======== Rooster CallData ========
async function buildCallData({ amountWei, recipient }) {
  const body = {
    inputTokenAddress: ZERO,           // native PLUME
    outputTokenAddress: PUSD,          // pUSD
    recipientAddress: recipient,       // penerima
    amount: amountWei.toString(),      // wei
    slippage: Number(SLIPPAGE_PERCENT),
    amountOutMinimum: ''               // biar dihitung API berdasar slippage
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(CALLDATA_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        console.log(`  ⚠ CallData API gagal (attempt ${attempt}): ${res.status} ${txt}`);
        if (attempt === 2) throw new Error(`CallData API error ${res.status}`);
        await wait(1200);
        continue;
      }
      const json = await res.json();
      if (!json?.to || !json?.callData) throw new Error('Response callData tidak lengkap');
      return {
        to: json.to,
        data: json.callData,
        value: BigInt(json.value ?? amountWei.toString()), // hex/dec ok
        expectedOutput: json.expectedOutput,
        minOut: json.amountOutMinimum,
        slippage: json.slippage,
      };
    } catch (e) {
      if (attempt === 2) throw e;
      await wait(1200);
    }
  }
  throw new Error('CallData gagal setelah retry');
}

// ======== Swap Flow ========
async function swapOnce(wallet) {
  const addr = await wallet.getAddress();
  const bal = await provider.getBalance(addr);
  console.log(`→ Wallet: ${addr}`);
  console.log(`  Balance: ${ethers.formatEther(bal)} PLUME`);

  const amountWei = pickAmountWei(bal);
  if (amountWei <= 0n) {
    console.log('  ❗ Balance tidak cukup untuk swap (habis untuk gas). Skip.');
    return;
  }

  console.log(`  Swap: ${ethers.formatEther(amountWei)} PLUME → pUSD`);
  const cd = await buildCallData({ amountWei, recipient: addr });

  const txReq = { to: cd.to, data: cd.data, value: cd.value };

  try {
    const gas = await wallet.estimateGas(txReq).catch(() => null);
    if (gas) txReq.gasLimit = gas;
  } catch (_) {}

  const tx = await wallet.sendTransaction(txReq);
  console.log(`  Tx sent: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  ✅ Sukses. Block ${rc.blockNumber}. Explorer: https://explorer.plume.org/tx/${tx.hash}`);
}

async function run() {
  await ensureChain();

  const pks = readPrivateKeys('account.txt');
  if (pks.length === 0) throw new Error('account.txt kosong / tidak ditemukan.');

  console.log('=== Rooster Auto Swap: PLUME → pUSD (Plume Mainnet) ===');
  console.log(`RPC: ${PLUME_RPC}`);
  console.log(`Loops per wallet: ${LOOPS}`);
  console.log(`Delay: ${DELAY_MIN_SEC}-${DELAY_MAX_SEC}s | Mode: ${AMOUNT_MODE} (${MIN_PLUME}-${MAX_PLUME} PLUME)`);

  for (const [i, pk] of pks.entries()) {
    const wallet = new ethers.Wallet(pk, provider);
    console.log(`\n[${i + 1}/${pks.length}]`);
    for (let c = 1; c <= Number(LOOPS); c++) {
      console.log(`  -- Cycle ${c}/${LOOPS} --`);
      try {
        await swapOnce(wallet);
      } catch (e) {
        console.log(`  ✖ Gagal swap: ${e.message || e}`);
      }
      if (c < Number(LOOPS)) await delayRandom();
    }
  }
  console.log('\n=== Selesai ===');
}

run().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
