---
title: Overview

slug: /aleph_zero/project_structure
---

This section provides an overview of the structural organization of the Invariant protocol smart contract project on Aleph Zero. The project is meticulously structured to enhance readability, maintainability, and efficiency. The architecture is designed to consolidate data within a single contract, minimizing fees and simplifying interactions.

## Contract Architecture

To optimize gas usage, we centralize data and entrypoints in a singular contract, reducing expenses associated with pool and position creation. This streamlined approach not only cuts costs but also simplifies processes, enhancing accessibility. By concentrating state changes and entrypoints within this central contract, we eliminate the intricacies of managing external contracts, while smart mapping intelligently conserves storage resources and bolsters system efficiency.

## Project structure

The following presents the project's overall structure, supplying insights into the logical segmentation into modules:

```
📦protocol-a0
 ┣ 📂contracts
 ┃ ┣ 📂collections
 ┃ ┣ 📂logic
 ┃ ┣ 📂storage
 | ┗ 📜entrypoints.rs
 ┣ 📂decimal
 ┣ 📂math
 ┣ 📂test_helpers
 ┣ 📂e2e
 ┣ 📂token
 ┗ 📂traceable_result
```

### [Decimal](https://github.com/invariant-labs/decimal)

Contained within the "Decimal" directory is a specialized decimal library. This library serves as the foundation for creating custom data types and executing precise mathematical calculations, ensuring accuracy and reliability in our contract.

### Math

The "Math" directory serves as a repository for core mathematical functions, constants, and custom data types that are meticulously crafted using the Decimal library. These mathematical components are indispensable for performing complex calculations in our contract. This directory includes crucial types like Liquidity and SqrtPrice. For an in-depth understanding of the mathematical specifications implemented in our project, please refer to our comprehensive [Math Specification Document](https://invariant.app/math-spec-a0.pdf). This document provides detailed insights into the design choices, algorithms, and methodologies underpinning our mathematical components.

### Contracts

Within this directory, we house our contract structures, collections, and associated logic. These components are pivotal in facilitating the seamless operation of our contract.

#### Storage

The "Storage" directory houses indispensable data structures crucial for contract storage. These structs are specifically crafted to facilitate the sharing of the state of the exchange within the CLAMM model. Notable examples of these structs include Tick, Pool, and others. These data structures play a pivotal role in maintaining and organizing information related to the exchange, ensuring efficient and organized handling of data within the CLAMM model. For instance, the "Tick" struct encapsulates crucial pricing information, while the "Pool" struct manages liquidity pools.

#### Collections

Our "Collections" directory is dedicated to collections of data that leverage structs with mappings or vectors. These collections play a crucial role in organizing and managing data in a structured manner, enhancing the overall functionality and performance of our contract. Within our collection interface, we enforce a tightly defined set of operations available for all data collections. Each collection implements the same basic methods, allowing for consistent data management regardless of the underlying data structures (vectors or mappings).

#### Logic

The "Logic" folder hosts a suite of mathematical calculations which are primarily designed for conducting test calculations and supporting our Software Development Kit (SDK). It is noteworthy that optimization efforts for these calculations need not be exhaustive, as they are intended for offline use and will not be executed on the blockchain.

### Test Helpers

The "Test Helpers" directory contains macros designed for efficient end-to-end testing. These macros abstract low-level calls and transaction building, allowing developers to focus solely on verifying expected logic during tests. This minimizes code repetition, simplifies the testing interface, and ensures a clear and concise testing environment.

### e2e

The "e2e" subfolder in our repository hosts an extensive suite of end-to-end (e2e) tests meticulously designed to validate and verify expected behaviors within our protocol. These tests cover entrypoints for both basic and edge cases, ensuring thorough examination of the protocol's functionality across a spectrum of scenarios.

### Token

The "Token" directory is solely for the implementation of a basic PSP22 token, serving as a key element in our end-to-end tests. It enables us to simulate production-ready token interactions and transactions, with the exchange operating specifically on PSP22 tokens. This detail is essential for implementing transfers in entrypoints and conducting thorough end-to-end tests to validate the protocol.

### Traceable Result

In the "Traceable Result" directory, you will find a comprehensive library comprising data structures used in debugging processes. In the event of an error, this library generates a detailed stack trace, providing valuable insights that aid in the identification and resolution of issues, thereby promoting the reliability and stability of our contract.

### Source Code Access

For a detailed exploration of our contract structures, collections, and associated logic, please refer to the corresponding [Source Code Repository](https://github.com/invariant-labs/protocol-a0). This repository contains the complete and up-to-date implementation of our contract architecture. Here lies the comprehensive project structure, which can be represented as follows.

```
📦protocol-a0
┣ 📂contracts
┃ ┣ 📂collections
┃ ┃ ┣ 📜fee_tiers.rs
┃ ┃ ┣ 📜pools.rs
┃ ┃ ┣ 📜positions.rs
┃ ┃ ┣ 📜pool_keys.rs
┃ ┃ ┗ 📜ticks.rs
┃ ┣ 📂logic
┃ ┃ ┗ 📜math.rs
┃ ┣ 📂storage
┃ ┃ ┣ 📜fee_tier.rs
┃ ┃ ┣ 📜pool_key.rs
┃ ┃ ┣ 📜pool.rs
┃ ┃ ┣ 📜position.rs
┃ ┃ ┣ 📜state.rs
┃ ┃ ┣ 📜tick.rs
┃ ┃ ┗ 📜tickmap.rs
┃ ┗ 📜entrypoints.rs
┣ 📂decimal
┣ 📂math
┃ ┣ 📂types
┃ ┃ ┣ 📜sqrt_price.rs
┃ ┃ ┣ 📜fee_growth.rs
┃ ┃ ┣ 📜fixed_point.rs
┃ ┃ ┣ 📜liquidity.rs
┃ ┃ ┣ 📜percentage.rs
┃ ┃ ┣ 📜seconds_per_liquidity.rs
┃ ┃ ┗ 📜token_amount.rs
┃ ┣ 📜consts.rs
┃ ┣ 📜log.rs
┃ ┗ 📜clamm.rs
┃ 📂test_helpers
┃ ┣ 📜lib.rs
┃ ┣ 📜snippets.rs
┃ ┣ 📜token.rs
┃ ┗ 📜entrypoints.rs
┃ 📂e2e
┃ ┣ 📜add_fee_tier.rs
┃ ┣ 📜change_fee_receiver.rs
┃ ┣ 📜change_protocol_fee.rs
┃ ┣ 📜claim.rs
┃ ┣ 📜constructor.rs
┃ ┣ 📜create_pool.rs
┃ ┣ 📜cross_both_side.rs
┃ ┣ 📜cross.rs
┃ ┣ 📜limits.rs
┃ ┣ 📜liquidity_gap.rs
┃ ┣ 📜max_tick_cross.rs
┃ ┣ 📜multiple_swap.rs
┃ ┣ 📜position_list.rs
┃ ┣ 📜position_slippage.rs
┃ ┣ 📜position.rs
┃ ┣ 📜protocol_fee.rs
┃ ┣ 📜remove_fee_tier.rs
┃ ┣ 📜slippage.rs
┃ ┣ 📜swap_route.rs
┃ ┗ 📜swap.rs
┣ 📂token
┃ ┣ 📜data.rs
┃ ┣ 📜errors.rs
┃ ┣ 📜lib.rs
┃ ┣ 📜testing.rs
┃ ┗ 📜traits.rs
┣ 📂traceable_result
┃ ┗ 📜lib.rs
┗ 📜lib.rs
```