// relayer-stress.js
require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const RPC_URL = "https://0x4e454228.rpc.aurora-cloud.dev";
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY, new ethers.providers.JsonRpcProvider(RPC_URL));

// OmegaStressMock contract details
const STRESS_CONTRACT = "0xa8bfcb9fe69b1627c6c99b0c74032c842cad016e";
const STRESS_ABI = [
	{
		"inputs": [
			{
				"internalType": "bytes",
				"name": "data",
				"type": "bytes"
			},
			{
				"internalType": "uint256",
				"name": "callType",
				"type": "uint256"
			},
			{
				"internalType": "string",
				"name": "note",
				"type": "string"
			}
		],
		"name": "stress",
		"outputs": [],
		"stateMutability": "payable",
		"type": "function"
	},
	{
		"anonymous": false,
		"inputs": [
			{
				"indexed": true,
				"internalType": "address",
				"name": "sender",
				"type": "address"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "value",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "bytes",
				"name": "data",
				"type": "bytes"
			},
			{
				"indexed": false,
				"internalType": "uint256",
				"name": "callType",
				"type": "uint256"
			},
			{
				"indexed": false,
				"internalType": "string",
				"name": "note",
				"type": "string"
			}
		],
		"name": "StressCalled",
		"type": "event"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "n",
				"type": "uint256"
			}
		],
		"name": "stressMaybeRevert",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "uint256",
				"name": "n",
				"type": "uint256"
			}
		],
		"name": "stressNumber",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "string",
				"name": "s",
				"type": "string"
			}
		],
		"name": "stressString",
		"outputs": [],
		"stateMutability": "nonpayable",
		"type": "function"
	},
	{
		"inputs": [],
		"name": "callCount",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	},
	{
		"inputs": [
			{
				"internalType": "address",
				"name": "",
				"type": "address"
			}
		],
		"name": "userCalls",
		"outputs": [
			{
				"internalType": "uint256",
				"name": "",
				"type": "uint256"
			}
		],
		"stateMutability": "view",
		"type": "function"
	}
];

const stressContract = new ethers.Contract(STRESS_CONTRACT, STRESS_ABI, relayerWallet);

// Add a global funding queue
let lastFundingPromise = Promise.resolve();

function randomAddress() {
    // Generate a random 20-byte address
    return '0x' + [...Array(40)].map(() => Math.floor(Math.random()*16).toString(16)).join('');
}

function randomValue() {
    // Random value between 0 and 0.001 OMEGA
    return ethers.utils.parseEther((Math.random() * 0.001).toFixed(6));
}

function randomData() {
    // Generate random bytes data
    return ethers.utils.hexlify(crypto.randomBytes(Math.floor(Math.random() * 64) + 16));
}

function randomString() {
    // Generate random string
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({length: Math.floor(Math.random() * 20) + 5}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function randomNumber() {
    // Generate random number
    return Math.floor(Math.random() * 1000000);
}

// Stress test endpoint
app.post('/stress-tx', async (req, res) => {
    try {
        const { walletIdx, txIdx } = req.body;

        // 1. Generate a new ephemeral wallet
        const ephemeralWallet = ethers.Wallet.createRandom();
        const ephemeralAddress = ephemeralWallet.address;
        const ephemeral = ephemeralWallet.connect(relayerWallet.provider);
        const FUND_AMOUNT = ethers.utils.parseEther('0.002'); // enough for one tx

        // 2. Fund the ephemeral wallet from the relayer (serialize funding)
        let gasPrice;
        try {
            gasPrice = await relayerWallet.provider.getGasPrice();
            gasPrice = gasPrice.mul(12).div(10); // 20% higher
        } catch (e) {
            gasPrice = undefined; // fallback to default
        }
        // Use a queue to serialize funding txs
        lastFundingPromise = lastFundingPromise.then(async () => {
            const fundTx = await relayerWallet.sendTransaction({
                to: ephemeralAddress,
                value: FUND_AMOUNT,
                gasLimit: 21000,
                ...(gasPrice ? { gasPrice } : {})
            });
            console.log(`Funding ephemeral wallet ${ephemeralAddress} (tx: ${fundTx.hash})`);
            await fundTx.wait();
        });
        await lastFundingPromise;

        // 3. Wait for balance (up to 20 tries, 2s interval)
        let tries = 0;
        let bal = await relayerWallet.provider.getBalance(ephemeralAddress);
        while (bal.lt(ethers.utils.parseEther('0.0015')) && tries < 20) {
            await new Promise(r => setTimeout(r, 2000));
            bal = await relayerWallet.provider.getBalance(ephemeralAddress);
            tries++;
            if (tries % 5 === 0) console.log(`Waiting for ephemeral wallet funding... (${tries} tries)`);
        }
        if (bal.lt(ethers.utils.parseEther('0.0015'))) {
            console.error(`Ephemeral wallet ${ephemeralAddress} did not receive sufficient funds after waiting. Skipping tx.`);
            return res.json({
                success: false,
                error: 'Ephemeral wallet did not receive sufficient funds in time',
                ephemeralAddress,
                walletIdx,
                txIdx
            });
        }
        // 4. Randomly choose which stress test method to call
        const methodChoice = Math.floor(Math.random() * 5); // 0-4 for different methods
        let tx;
        let methodName;
        const stressEphemeral = new ethers.Contract(STRESS_CONTRACT, STRESS_ABI, ephemeral);
        switch (methodChoice) {
            case 0:
                const callType = Math.floor(Math.random() * 4);
                const data = randomData();
                const note = `Stress test ${Date.now()}`;
                const value = Math.random() > 0.7 ? ethers.utils.parseEther('0.0005') : 0;
                tx = await stressEphemeral.stress(data, callType, note, {
                    value,
                    gasLimit: 150000
                });
                methodName = `stress(${callType}, "${note}")`;
                break;
            case 1:
                const n1 = randomNumber();
                tx = await stressEphemeral.stressMaybeRevert(n1, {
                    gasLimit: 100000
                });
                methodName = `stressMaybeRevert(${n1})`;
                break;
            case 2:
                const n2 = randomNumber();
                tx = await stressEphemeral.stressNumber(n2, {
                    gasLimit: 100000
                });
                methodName = `stressNumber(${n2})`;
                break;
            case 3:
                const s = randomString();
                tx = await stressEphemeral.stressString(s, {
                    gasLimit: 100000
                });
                methodName = `stressString("${s}")`;
                break;
            case 4:
                // Native transfer to random address
                const toAddress = randomAddress();
                const transferValue = ethers.utils.parseEther('0.0005');
                tx = await ephemeral.sendTransaction({
                    to: toAddress,
                    value: transferValue,
                    gasLimit: 21000
                });
                methodName = `transfer(${ethers.utils.formatEther(transferValue)} OMEGA)`;
                break;
        }
        await tx.wait();
        console.log(`✅ Ephemeral tx ${txIdx} (wallet ${walletIdx}): ${methodName} - ${tx.hash}`);
        res.json({
            success: true,
            txHash: tx.hash,
            ephemeralAddress,
            method: methodName,
            walletIdx,
            txIdx
        });
    } catch (error) {
        console.error(`❌ Ephemeral stress tx failed: ${error.message}`);
        res.json({
            success: false,
            error: error.message,
            walletIdx: req.body.walletIdx,
            txIdx: req.body.txIdx
        });
    }
});

// Get contract stats
app.get('/stress-stats', async (req, res) => {
    try {
        const callCount = await stressContract.callCount();
        const userCalls = await stressContract.userCalls(relayerWallet.address);
        
        res.json({
            success: true,
            totalCalls: callCount.toString(),
            relayerCalls: userCalls.toString(),
            contractAddress: STRESS_CONTRACT
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        relayerAddress: relayerWallet.address,
        contractAddress: STRESS_CONTRACT
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Omega Stress Test Relayer running on port ${PORT}`);
    console.log(`📊 Relayer address: ${relayerWallet.address}`);
    console.log(`📋 Stress contract: ${STRESS_CONTRACT}`);
    console.log(`🔗 Endpoints:`);
    console.log(`   POST /stress-tx - Send stress test transaction`);
    console.log(`   GET  /stress-stats - Get contract statistics`);
    console.log(`   GET  /health - Health check`);
}); 
