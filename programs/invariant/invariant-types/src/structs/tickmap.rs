use std::convert::TryInto;

use crate::size;
use anchor_lang::prelude::*;

#[account(zero_copy)]
#[repr(packed)]
#[derive(AnchorDeserialize)]
pub struct Tickmap {
    pub bitmap: [u8; 11091], // Tick limit / 4
}

impl Default for Tickmap {
    fn default() -> Self {
        Tickmap { bitmap: [0; 11091] }
    }
}

size!(Tickmap);

pub const TICK_LIMIT: i32 = 44_364; // If you change it update length of array as well!
pub const TICK_SEARCH_RANGE: i32 = 256;
pub const MAX_TICK: i32 = 221_818; // log(1.0001, sqrt(2^64-1))
pub const TICK_CROSSES_PER_IX: usize = 19;
pub const TICKMAP_SIZE: i32 = 2 * TICK_LIMIT - 1;

fn tick_to_position(tick: i32, tick_spacing: u16) -> (usize, u8) {
    assert_eq!(
        (tick % tick_spacing as i32),
        0,
        "tick not divisible by spacing"
    );

    let bitmap_index = tick
        .checked_div(tick_spacing.try_into().unwrap())
        .unwrap()
        .checked_add(TICK_LIMIT)
        .unwrap();

    let byte: usize = (bitmap_index.checked_div(8).unwrap()).try_into().unwrap();
    let bit: u8 = (bitmap_index % 8).abs().try_into().unwrap();

    (byte, bit)
}

pub fn get_search_limit(tick: i32, tick_spacing: u16, up: bool) -> i32 {
    let index = tick / tick_spacing as i32;

    let limit = if up {
        // ticks are limited by amount of space in the bitmap...
        let array_limit = TICK_LIMIT.checked_sub(1).unwrap();
        // ...search range is limited to 256 at the time ...
        let range_limit = index.checked_add(TICK_SEARCH_RANGE).unwrap();
        // ...also ticks for prices over 2^64 aren't needed
        let price_limit = MAX_TICK.checked_div(tick_spacing as i32).unwrap();

        array_limit.min(range_limit).min(price_limit)
    } else {
        let array_limit = (-TICK_LIMIT).checked_add(1).unwrap();
        let range_limit = index.checked_sub(TICK_SEARCH_RANGE).unwrap();
        let price_limit = -MAX_TICK.checked_div(tick_spacing as i32).unwrap();

        array_limit.max(range_limit).max(price_limit)
    };

    limit.checked_mul(tick_spacing as i32).unwrap()
}

impl Tickmap {
    pub fn next_initialized(&self, tick: i32, tick_spacing: u16) -> Option<i32> {
        let limit = get_search_limit(tick, tick_spacing, true);

        // add 1 to not check current tick
        let (mut byte, mut bit) =
            tick_to_position(tick.checked_add(tick_spacing as i32).unwrap(), tick_spacing);
        let (limiting_byte, limiting_bit) = tick_to_position(limit, tick_spacing);

        while byte < limiting_byte || (byte == limiting_byte && bit <= limiting_bit) {
            // ignore some bits on first loop
            let mut shifted = self.bitmap[byte] >> bit;

            // go through all bits in byte until it is zero
            if shifted != 0 {
                while shifted.checked_rem(2).unwrap() == 0 {
                    shifted >>= 1;
                    bit = bit.checked_add(1).unwrap();
                }

                return if byte < limiting_byte || (byte == limiting_byte && bit <= limiting_bit) {
                    let index: i32 = byte
                        .checked_mul(8)
                        .unwrap()
                        .checked_add(bit.into())
                        .unwrap()
                        .try_into()
                        .unwrap();
                    Some(
                        index
                            .checked_sub(TICK_LIMIT)
                            .unwrap()
                            .checked_mul(tick_spacing.try_into().unwrap())
                            .unwrap(),
                    )
                } else {
                    None
                };
            }

            // go to the text byte
            byte = byte.checked_add(1).unwrap();
            bit = 0;
        }

        None
    }

    pub fn prev_initialized(&self, tick: i32, tick_spacing: u16) -> Option<i32> {
        // don't subtract 1 to check the current tick
        let limit = get_search_limit(tick, tick_spacing, false);
        let (mut byte, mut bit) = tick_to_position(tick as i32, tick_spacing);
        let (limiting_byte, limiting_bit) = tick_to_position(limit, tick_spacing);

        while byte > limiting_byte || (byte == limiting_byte && bit >= limiting_bit) {
            let mut mask = 1u16.checked_shl(bit.try_into().unwrap()).unwrap();
            let value = self.bitmap[byte] as u16;

            if value.checked_rem(mask.checked_shl(1).unwrap()).unwrap() > 0 {
                while value & mask == 0 {
                    mask >>= 1;
                    bit = bit.checked_sub(1).unwrap();
                }

                return if byte > limiting_byte || (byte == limiting_byte && bit >= limiting_bit) {
                    let index: i32 = byte
                        .checked_mul(8)
                        .unwrap()
                        .checked_add(bit.into())
                        .unwrap()
                        .try_into()
                        .unwrap();

                    Some(
                        index
                            .checked_sub(TICK_LIMIT)
                            .unwrap()
                            .checked_mul(tick_spacing.try_into().unwrap())
                            .unwrap(),
                    )
                } else {
                    None
                };
            }

            // go to the text byte
            byte = byte.checked_sub(1).unwrap();
            bit = 7;
        }

        None
    }
}
