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
let lastTransactionTime = 0;
const TRANSACTION_DELAY = 20000; // 20 seconds in milliseconds

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

        // Enforce 20-second delay between transactions
        const now = Date.now();
        const timeSinceLastTx = now - lastTransactionTime;
        if (timeSinceLastTx < TRANSACTION_DELAY) {
            const waitTime = TRANSACTION_DELAY - timeSinceLastTx;
            console.log(`⏳ Waiting ${waitTime/1000}s before next transaction...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        lastTransactionTime = Date.now();

        // 1. Generate a new ephemeral wallet
        const ephemeralWallet = ethers.Wallet.createRandom();
        const ephemeralAddress = ephemeralWallet.address;
        const ephemeral = ephemeralWallet.connect(relayerWallet.provider);
        const FUND_AMOUNT = ethers.utils.parseEther('0.002'); // enough for one tx

        console.log(`🔄 Starting stress tx for Wallet #${walletIdx+1} Tx #${txIdx+1} (${ephemeralAddress})`);

        // 2. Fund the ephemeral wallet from the relayer (serialized)
        lastFundingPromise = lastFundingPromise.then(async () => {
            console.log(`💰 Funding ephemeral wallet ${ephemeralAddress}...`);
            const fundTx = await relayerWallet.sendTransaction({
                to: ephemeralAddress,
                value: FUND_AMOUNT,
                gasLimit: 21000,
                gasPrice: (await relayerWallet.provider.getGasPrice()).mul(120).div(100) // 20% higher gas price
            });
            console.log(`📤 Funding tx sent: ${fundTx.hash}`);
            await fundTx.wait();
            console.log(`✅ Funding confirmed for ${ephemeralAddress}`);
        });
        await lastFundingPromise;

        // 3. Wait for balance to be available
        console.log(`⏳ Waiting for balance to be available...`);
        let tries = 0;
        let balance = ethers.BigNumber.from(0);
        while (tries < 20) {
            balance = await relayerWallet.provider.getBalance(ephemeralAddress);
            if (balance.gte(ethers.utils.parseEther('0.0015'))) {
                console.log(`✅ Balance confirmed: ${ethers.utils.formatEther(balance)} OMEGA`);
                break;
            }
            console.log(`⏳ Balance check ${tries+1}/20: ${ethers.utils.formatEther(balance)} OMEGA`);
            await new Promise(resolve => setTimeout(resolve, 2000));
            tries++;
        }

        if (balance.lt(ethers.utils.parseEther('0.0015'))) {
            console.log(`❌ Insufficient balance after funding: ${ethers.utils.formatEther(balance)} OMEGA`);
            res.json({ success: false, error: 'Insufficient balance after funding' });
            return;
        }

        // 4. Send stress transaction from ephemeral wallet
        console.log(`🚀 Sending stress transaction from ephemeral wallet...`);
        const method = Math.floor(Math.random() * 5);
        let stressTx;

        try {
            switch (method) {
                case 0:
                    // stress(bytes, uint256, string)
                    const randomData = crypto.randomBytes(32);
                    const callType = Math.floor(Math.random() * 10);
                    const note = `Stress test ${Date.now()}`;
                    stressTx = await stressContract.connect(ephemeral).stress(randomData, callType, note, {
                        gasLimit: 200000,
                        value: ethers.utils.parseEther('0.0001')
                    });
                    break;
                case 1:
                    // stressMaybeRevert(uint256)
                    const n1 = Math.floor(Math.random() * 1000);
                    stressTx = await stressContract.connect(ephemeral).stressMaybeRevert(n1, { gasLimit: 100000 });
                    break;
                case 2:
                    // stressNumber(uint256)
                    const n2 = Math.floor(Math.random() * 1000000);
                    stressTx = await stressContract.connect(ephemeral).stressNumber(n2, { gasLimit: 100000 });
                    break;
                case 3:
                    // stressString(string)
                    const s = `Stress string ${Date.now()}`;
                    stressTx = await stressContract.connect(ephemeral).stressString(s, { gasLimit: 100000 });
                    break;
                case 4:
                    // Native transfer
                    const randomRecipient = randomAddress();
                    const randomValue = ethers.utils.parseEther((Math.random() * 0.001).toFixed(6));
                    stressTx = await ephemeral.sendTransaction({
                        to: randomRecipient,
                        value: randomValue,
                        gasLimit: 21000
                    });
                    break;
            }

            await stressTx.wait();
            console.log(`✅ Stress transaction successful: ${stressTx.hash}`);
            res.json({ 
                success: true, 
                txHash: stressTx.hash, 
                ephemeralAddress: ephemeralAddress,
                method: method 
            });

        } catch (error) {
            console.log(`❌ Ephemeral stress tx failed: ${error.message}`);
            res.json({ 
                success: false, 
                error: error.message,
                ephemeralAddress: ephemeralAddress 
            });
        }

    } catch (error) {
        console.log(`❌ Stress tx error: ${error.message}`);
        res.json({ success: false, error: error.message });
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
