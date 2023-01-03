use crate::errors::InvariantErrorCode;
use crate::interfaces::SendTokens;
use crate::structs::pool::Pool;
use crate::structs::state::State;
use crate::SEED;
use crate::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, TokenAccount, Transfer};

#[derive(Accounts)]
pub struct WithdrawProtocolFee<'info> {
    #[account(seeds = [b"statev1".as_ref()], bump = state.load()?.bump)]
    pub state: AccountLoader<'info, State>,
    #[account(mut,
        seeds = [b"poolv1", token_x.key().as_ref(), token_y.key().as_ref(), &pool.load()?.fee.v.to_le_bytes(), &pool.load()?.tick_spacing.to_le_bytes()],
        bump = pool.load()?.bump
    )]
    pub pool: AccountLoader<'info, Pool>,
    #[account(constraint = token_x.key() == pool.load()?.token_x @ InvariantErrorCode::InvalidTokenAccount)]
    pub token_x: Account<'info, Mint>,
    #[account(constraint = token_y.key() == pool.load()?.token_y @ InvariantErrorCode::InvalidTokenAccount)]
    pub token_y: Account<'info, Mint>,
    #[account(mut,
        constraint = account_x.mint == token_x.key() @ InvariantErrorCode::InvalidMint
    )]
    pub account_x: Box<Account<'info, TokenAccount>>,
    #[account(mut,
        constraint = account_y.mint == token_y.key() @ InvariantErrorCode::InvalidMint
    )]
    pub account_y: Box<Account<'info, TokenAccount>>,
    #[account(mut,
        constraint = reserve_x.mint == token_x.key() @ InvariantErrorCode::InvalidMint,
        constraint = &reserve_x.owner == program_authority.key @ InvariantErrorCode::InvalidAuthority,
        constraint = reserve_x.key() == pool.load()?.token_x_reserve @ InvariantErrorCode::InvalidTokenAccount
    )]
    pub reserve_x: Account<'info, TokenAccount>,
    #[account(mut,
        constraint = reserve_y.mint == token_y.key() @ InvariantErrorCode::InvalidMint,
        constraint = &reserve_y.owner == program_authority.key @ InvariantErrorCode::InvalidAuthority,
        constraint = reserve_y.key() == pool.load()?.token_y_reserve @ InvariantErrorCode::InvalidTokenAccount
    )]
    pub reserve_y: Account<'info, TokenAccount>,
    #[account(constraint = &pool.load()?.fee_receiver == authority.key @ InvariantErrorCode::InvalidAuthority)]
    /// CHECK: safe as read from state
    pub authority: Signer<'info>,
    /// CHECK: safe as read from state
    #[account(constraint = &state.load()?.authority == program_authority.key @ InvariantErrorCode::InvalidAuthority)]
    pub program_authority: AccountInfo<'info>,
    /// CHECK: safe as constant
    #[account(address = token::ID)]
    pub token_program: AccountInfo<'info>,
}

impl<'info> SendTokens<'info> for WithdrawProtocolFee<'info> {
    fn send_x(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.reserve_x.to_account_info(),
                to: self.account_x.to_account_info(),
                authority: self.program_authority.clone(),
            },
        )
    }

    fn send_y(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Transfer {
                from: self.reserve_y.to_account_info(),
                to: self.account_y.to_account_info(),
                authority: self.program_authority.clone(),
            },
        )
    }
}

impl<'info> WithdrawProtocolFee<'info> {
    pub fn handler(&self) -> Result<()> {
        msg!("INVARIANT: WITHDRAW PROTOCOL FEE");

        let state = self.state.load()?;
        let mut pool = self.pool.load_mut()?;

        let signer: &[&[&[u8]]] = get_signer!(state.nonce);

        let cpi_ctx_x = self.send_x().with_signer(signer);
        let cpi_ctx_y = self.send_y().with_signer(signer);

        token::transfer(cpi_ctx_x, pool.fee_protocol_token_x)?;
        token::transfer(cpi_ctx_y, pool.fee_protocol_token_y)?;

        pool.fee_protocol_token_x = 0;
        pool.fee_protocol_token_y = 0;

        Ok(())
    }
}
