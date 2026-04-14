import "@stdlib/deploy";
import "@stdlib/ownable";

// ─── Messages ───────────────────────────────────────────────────────────────

message MintChipsNFT {
    recipient: Address;
    chipsAmount: Int as uint64;
    queryId: Int as uint64;
}

message RedeemNFT {
    queryId: Int as uint64;
}

message TransferNFT {
    queryId: Int as uint64;
    newOwner: Address;
    responseDestination: Address?;
    customPayload: Cell?;
    forwardAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message NFTData {
    initialized: Bool;
    index: Int as uint256;
    collection: Address;
    owner: Address;
    content: Cell;
}

// ─── NFT Item Contract ───────────────────────────────────────────────────────

contract ChipsNFTItem {
    initialized: Bool = false;
    index: Int as uint256;
    collection: Address;
    owner: Address;
    chipsAmount: Int as uint64;
    royaltyAddress: Address;
    royaltyPercent: Int as uint8; // 20 = 20%

    init(index: Int, collection: Address, royaltyAddress: Address, royaltyPercent: Int) {
        self.index = index;
        self.collection = collection;
        self.owner = collection;
        self.chipsAmount = 0;
        self.royaltyAddress = royaltyAddress;
        self.royaltyPercent = royaltyPercent;
    }

    receive(msg: MintChipsNFT) {
        require(sender() == self.collection, "Only collection can mint");
        require(!self.initialized, "Already initialized");
        self.initialized = true;
        self.owner = msg.recipient;
        self.chipsAmount = msg.chipsAmount;
        
        // Notify recipient
        emit("NFT minted".asComment());
    }

    receive(msg: TransferNFT) {
        require(self.initialized, "Not initialized");
        require(sender() == self.owner, "Not the owner");

        let value: Int = context().value;
        let royaltyAmount: Int = value * self.royaltyPercent / 100;
        let sellerAmount: Int = value - royaltyAmount - ton("0.05");

        // Pay royalty to collection owner
        if (royaltyAmount > 0) {
            send(SendParameters{
                to: self.royaltyAddress,
                value: royaltyAmount,
                mode: SendIgnoreErrors,
                body: "Royalty payment".asComment()
            });
        }

        // Transfer ownership
        self.owner = msg.newOwner;

        // Notify new owner
        if (msg.responseDestination != null) {
            send(SendParameters{
                to: msg.responseDestination!!,
                value: sellerAmount,
                mode: SendIgnoreErrors,
                body: "Transfer complete".asComment()
            });
        }
    }

    receive(msg: RedeemNFT) {
        require(self.initialized, "Not initialized");
        require(sender() == self.owner, "Not the owner");
        
        // Send chips data back to collection for redemption processing
        send(SendParameters{
            to: self.collection,
            value: ton("0.05"),
            mode: SendIgnoreErrors,
            body: beginCell()
                .storeUint(0x52eddf8e, 32) // redeem opcode
                .storeUint(msg.queryId, 64)
                .storeAddress(self.owner)
                .storeUint(self.chipsAmount, 64)
                .endCell()
        });

        // Burn NFT (reset)
        self.initialized = false;
        self.chipsAmount = 0;
        self.owner = self.collection;
    }

    get fun getNFTData(): NFTData {
        let content: Cell = beginCell()
            .storeUint(self.chipsAmount, 64)
            .endCell();
            
        return NFTData{
            initialized: self.initialized,
            index: self.index,
            collection: self.collection,
            owner: self.owner,
            content: content
        };
    }

    get fun getChipsAmount(): Int {
        return self.chipsAmount;
    }
}

// ─── NFT Collection Contract ──────────────────────────────────────────────────

contract ChipsNFTCollection with Deployable, Ownable {
    owner: Address;
    nextItemIndex: Int as uint256 = 0;
    royaltyAddress: Address;
    royaltyPercent: Int as uint8 = 20; // 20%
    gameServer: Address; // Authorized game server

    init(owner: Address, royaltyAddress: Address, gameServer: Address) {
        self.owner = owner;
        self.royaltyAddress = royaltyAddress;
        self.gameServer = gameServer;
    }

    // Only game server can mint NFTs
    receive(msg: MintChipsNFT) {
        require(
            sender() == self.gameServer || sender() == self.owner,
            "Unauthorized minter"
        );
        require(msg.chipsAmount > 0, "Chips amount must be positive");

        let index: Int = self.nextItemIndex;
        self.nextItemIndex = index + 1;

        // Deploy NFT item
        let nftInit: StateInit = initOf ChipsNFTItem(
            index,
            myAddress(),
            self.royaltyAddress,
            self.royaltyPercent
        );

        let nftAddress: Address = contractAddress(nftInit);

        send(SendParameters{
            to: nftAddress,
            value: ton("0.05"),
            mode: SendIgnoreErrors,
            bounce: false,
            code: nftInit.code,
            data: nftInit.data,
            body: MintChipsNFT{
                recipient: msg.recipient,
                chipsAmount: msg.chipsAmount,
                queryId: msg.queryId
            }.toCell()
        });
    }

    // Handle redemption from NFT items
    receive(slice: Slice) {
        let op: Int = slice.loadUint(32);
        
        if (op == 0x52eddf8e) { // redeem opcode
            let queryId: Int = slice.loadUint(64);
            let redeemer: Address = slice.loadAddress();
            let chipsAmount: Int = slice.loadUint(64);

            // Notify game server to credit chips
            send(SendParameters{
                to: self.gameServer,
                value: ton("0.02"),
                mode: SendIgnoreErrors,
                body: beginCell()
                    .storeUint(0x12345678, 32) // credit_chips opcode
                    .storeUint(queryId, 64)
                    .storeAddress(redeemer)
                    .storeUint(chipsAmount, 64)
                    .endCell()
            });
        }
    }

    fun getNFTAddress(index: Int): Address {
        let nftInit: StateInit = initOf ChipsNFTItem(
            index,
            myAddress(),
            self.royaltyAddress,
            self.royaltyPercent
        );
        return contractAddress(nftInit);
    }

    get fun getCollectionData(): Cell {
        return beginCell()
            .storeUint(self.nextItemIndex, 256)
            .storeAddress(self.owner)
            .storeAddress(self.royaltyAddress)
            .storeUint(self.royaltyPercent, 8)
            .endCell();
    }

    get fun getRoyaltyParams(): Cell {
        return beginCell()
            .storeUint(self.royaltyPercent, 16)
            .storeUint(100, 16)
            .storeAddress(self.royaltyAddress)
            .endCell();
    }

    get fun getNFTAddressByIndex(index: Int): Address {
        return self.getNFTAddress(index);
    }

    get fun getTotalMinted(): Int {
        return self.nextItemIndex;
    }
}
