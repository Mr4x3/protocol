use anchor_lang::__private::ErrorCode;
use anchor_lang::__private::CLOSED_ACCOUNT_DISCRIMINATOR;
use std::cell::RefMut;
use std::convert::TryInto;
use std::io::Write;

use crate::decimal::Decimal;
use crate::log::get_tick_at_sqrt_price;
use crate::math::calculate_price_sqrt;
use crate::structs::pool::Pool;
use crate::structs::tick::Tick;
use crate::structs::tickmap::Tickmap;
use crate::structs::tickmap::{get_search_limit, MAX_TICK, TICK_LIMIT, TICK_SEARCH_RANGE};
use crate::*;

pub fn check_ticks(tick_lower: i32, tick_upper: i32, tick_spacing: u16) -> Result<()> {
    // Check order
    require!(tick_lower < tick_upper, InvalidTickIndex);

    check_tick(tick_lower, tick_spacing)?;
    check_tick(tick_upper, tick_spacing)?;

    Ok(())
}

pub fn check_tick(tick_index: i32, tick_spacing: u16) -> Result<()> {
    // Check order
    require!(
        tick_index.checked_rem(tick_spacing.into()) == Some(0),
        InvalidTickIndex
    );

    let tickmap_index = tick_index.checked_div(tick_spacing.into()).unwrap();

    require!(tickmap_index > (-TICK_LIMIT), InvalidTickIndex);
    require!(tickmap_index < TICK_LIMIT - 1, InvalidTickIndex);
    require!(tick_index > (-MAX_TICK), InvalidTickIndex);
    require!(tick_index < MAX_TICK, InvalidTickIndex);

    Ok(())
}

// Finds closes initialized tick in direction of trade
// and compares its price to the price limit of the trade
pub fn get_closer_limit(
    sqrt_price_limit: Decimal,
    x_to_y: bool,
    current_tick: i32,
    tick_spacing: u16,
    tickmap: &Tickmap,
) -> Result<(Decimal, Option<(i32, bool)>)> {
    let closes_tick_index = if x_to_y {
        tickmap.prev_initialized(current_tick, tick_spacing)
    } else {
        tickmap.next_initialized(current_tick, tick_spacing)
    };

    match closes_tick_index {
        Some(index) => {
            let price = calculate_price_sqrt(index);
            // trunk-ignore(clippy/if_same_then_else)
            if x_to_y && price > sqrt_price_limit {
                Ok((price, Some((index, true))))
            } else if !x_to_y && price < sqrt_price_limit {
                Ok((price, Some((index, true))))
            } else {
                Ok((sqrt_price_limit, None))
            }
        }
        None => {
            let index = get_search_limit(current_tick, tick_spacing, !x_to_y);
            let price = calculate_price_sqrt(index);

            require!(current_tick != index, LimitReached);

            // trunk-ignore(clippy/if_same_then_else)
            if x_to_y && price > sqrt_price_limit {
                Ok((price, Some((index, false))))
            } else if !x_to_y && price < sqrt_price_limit {
                Ok((price, Some((index, false))))
            } else {
                Ok((sqrt_price_limit, None))
            }
        }
    }
}

pub fn cross_tick(tick: &mut RefMut<Tick>, pool: &mut Pool) -> Result<()> {
    tick.fee_growth_outside_x = pool.fee_growth_global_x - tick.fee_growth_outside_x;
    tick.fee_growth_outside_y = pool.fee_growth_global_y - tick.fee_growth_outside_y;

    let current_timestamp: u64 = Clock::get()?.unix_timestamp.try_into().unwrap();
    let seconds_passed: u64 = current_timestamp.checked_sub(pool.start_timestamp).unwrap();
    // overflow is valid here
    tick.seconds_outside = seconds_passed - tick.seconds_outside;

    if { pool.liquidity } != Decimal::new(0) {
        pool.update_seconds_per_liquidity_global(current_timestamp);
    } else {
        pool.last_timestamp = current_timestamp;
    }
    tick.seconds_per_liquidity_outside =
        pool.seconds_per_liquidity_global - tick.seconds_per_liquidity_outside;

    // When going to higher tick net_liquidity should be added and for going lower subtracted
    if (pool.current_tick_index >= tick.index) ^ tick.sign {
        pool.liquidity = pool.liquidity + tick.liquidity_change;
    } else {
        pool.liquidity = pool.liquidity - tick.liquidity_change;
    }

    Ok(())
}

pub fn get_tick_from_price(
    current_tick: i32,
    tick_spacing: u16,
    price: Decimal,
    x_to_y: bool,
) -> i32 {
    assert!(
        current_tick.checked_rem(tick_spacing.into()).unwrap() == 0,
        "tick not divisible by spacing"
    );

    get_tick_at_sqrt_price(price)
}

pub fn price_to_tick_in_range(price: Decimal, low: i32, high: i32, step: i32) -> i32 {
    let mut low = low.checked_div(step).unwrap();
    let mut high = high.checked_div(step).unwrap().checked_add(1).unwrap();
    let target_value = price;

    while high.checked_sub(low).unwrap() > 1 {
        let mid = ((high.checked_sub(low).unwrap()).checked_div(2).unwrap())
            .checked_add(low)
            .unwrap();
        let val = calculate_price_sqrt(mid.checked_mul(step).unwrap());

        if val == target_value {
            return mid.checked_mul(step).unwrap();
        }

        if val < target_value {
            low = mid;
        }

        if val > target_value {
            high = mid;
        }
    }
    low.checked_mul(step).unwrap()
}

pub fn close<'info>(
    info: AccountInfo<'info>,
    sol_destination: AccountInfo<'info>,
) -> ProgramResult {
    // Transfer tokens from the account to the sol_destination.
    let dest_starting_lamports = sol_destination.lamports();
    **sol_destination.lamports.borrow_mut() =
        dest_starting_lamports.checked_add(info.lamports()).unwrap();
    **info.lamports.borrow_mut() = 0;

    // Mark the account discriminator as closed.
    let mut data = info.try_borrow_mut_data()?;
    let dst: &mut [u8] = &mut data;
    let mut cursor = std::io::Cursor::new(dst);
    cursor
        .write_all(&CLOSED_ACCOUNT_DISCRIMINATOR)
        .map_err(|_| ErrorCode::AccountDidNotSerialize)?;
    Ok(())
}

#[cfg(test)]
mod test {
    use crate::log::get_tick_at_sqrt_price;

    use super::*;

    #[test]
    fn test_price_to_tick_in_range() {
        // Exact
        {
            let target_tick = 4;
            let result = price_to_tick_in_range(calculate_price_sqrt(target_tick), 0, 8, 2);
            let tick = get_tick_at_sqrt_price(calculate_price_sqrt(target_tick));
            assert_eq!(tick, target_tick);
            assert_eq!(result, target_tick);
        }
        // // Between
        // {
        //     let target_tick = 4;
        //     let target_price = calculate_price_sqrt(target_tick) + Decimal::new(1);
        //     let result = price_to_tick_in_range(target_price, 0, 8, 2);
        //     assert_eq!(result, target_tick);
        // }
        // // Big step
        // {
        //     let target_tick = 50;
        //     let target_price = calculate_price_sqrt(target_tick) + Decimal::new(1);
        //     let result = price_to_tick_in_range(target_price, 0, 200, 50);
        //     assert_eq!(result, target_tick);
        // }
        // // Big range
        // {
        //     let target_tick = 1234;
        //     let target_price = calculate_price_sqrt(target_tick);
        //     let result = price_to_tick_in_range(target_price, 0, 100_000, 2);
        //     assert_eq!(result, target_tick);
        // }
        // // Negative
        // {
        //     let target_tick = -50;
        //     let target_price = calculate_price_sqrt(target_tick) + Decimal::new(1);
        //     let result = price_to_tick_in_range(target_price, -200, 100, 2);
        //     assert_eq!(result, target_tick);
        // }
    }

    #[test]
    fn test_get_closer_limit() -> Result<()> {
        let tickmap = &mut Tickmap::default();
        tickmap.flip(true, 0, 1);

        // tick limit closer
        {
            let (result, from_tick) =
                get_closer_limit(Decimal::from_integer(5), true, 100, 1, tickmap)?;

            let expected = Decimal::from_integer(5);
            assert_eq!(result, expected);
            assert_eq!(from_tick, None);
        }
        // trade limit closer
        {
            let (result, from_tick) =
                get_closer_limit(Decimal::from_decimal(1, 1), true, 100, 1, tickmap)?;
            let expected = Decimal::from_integer(1);
            assert_eq!(result, expected);
            assert_eq!(from_tick, Some((0, true)));
        }
        // other direction
        {
            let (result, from_tick) =
                get_closer_limit(Decimal::from_integer(2), false, -5, 1, tickmap)?;
            let expected = Decimal::from_integer(1);
            assert_eq!(result, expected);
            assert_eq!(from_tick, Some((0, true)));
        }
        // other direction
        {
            let (result, from_tick) =
                get_closer_limit(Decimal::from_decimal(1, 1), false, -100, 10, tickmap)?;
            let expected = Decimal::from_decimal(1, 1);
            assert_eq!(result, expected);
            assert_eq!(from_tick, None);
        }
        Ok(())
    }
}
