--
-- PostgreSQL database dump
--

\restrict A4eREXwpLCCjtKyqJua0sDeEj4kxfXQffh8CrdtI9a76ybXcs7DHRZjI2FKwyBa

-- Dumped from database version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_chat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_chat (
    id bigint NOT NULL,
    asked_at timestamp with time zone DEFAULT now() NOT NULL,
    trading_date date NOT NULL,
    symbol text,
    question text NOT NULL,
    answer text,
    context_json jsonb,
    model text,
    tool_calls integer,
    tokens integer,
    flagged boolean DEFAULT false
);


--
-- Name: ai_chat_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_chat_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_chat_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_chat_id_seq OWNED BY public.ai_chat.id;


--
-- Name: ai_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_memory (
    id bigint NOT NULL,
    learned_on date DEFAULT CURRENT_DATE NOT NULL,
    symbol text,
    fact text NOT NULL,
    source text,
    confirmed_by_user boolean DEFAULT false,
    still_true boolean DEFAULT true,
    exported boolean DEFAULT false
);


--
-- Name: ai_memory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_memory_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_memory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_memory_id_seq OWNED BY public.ai_memory.id;


--
-- Name: ai_query_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_query_log (
    id bigint NOT NULL,
    chat_id bigint,
    ran_at timestamp with time zone DEFAULT now(),
    sql text NOT NULL,
    rows integer,
    duration_ms integer,
    error text
);


--
-- Name: ai_query_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_query_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_query_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_query_log_id_seq OWNED BY public.ai_query_log.id;


--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value text NOT NULL,
    is_secret boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by text
);


--
-- Name: awsat_market_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.awsat_market_quotes (
    id bigint NOT NULL,
    scrape_batch_id uuid,
    market text NOT NULL,
    symbol text NOT NULL,
    code text,
    description text,
    last_price numeric(18,4),
    last_qty bigint,
    chg numeric(18,4),
    pct_chg numeric(10,4),
    volume bigint,
    bid numeric(18,4),
    bid_qty bigint,
    offer numeric(18,4),
    offer_qty bigint,
    trades integer,
    last_trade_date date,
    last_trade_time time without time zone,
    open_price numeric(18,4),
    high_price numeric(18,4),
    low_price numeric(18,4),
    session text,
    nms numeric(18,4),
    trading_date date NOT NULL,
    ingest_source text NOT NULL,
    source_precedence smallint DEFAULT 0 NOT NULL,
    run_id bigint,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: awsat_market_quotes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.awsat_market_quotes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: awsat_market_quotes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.awsat_market_quotes_id_seq OWNED BY public.awsat_market_quotes.id;


--
-- Name: awsat_market_summary; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.awsat_market_summary (
    captured_at timestamp with time zone NOT NULL,
    trading_date date NOT NULL,
    session_state text NOT NULL,
    symbols_traded integer,
    advancing integer,
    declining integer,
    unchanged integer,
    total_volume bigint,
    total_trades bigint,
    turnover_kd numeric,
    index_close numeric,
    index_ytd_pct numeric,
    fields_found integer,
    batch_id text,
    source text DEFAULT 'awsat_client'::text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: awsat_order_list; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.awsat_order_list (
    id bigint NOT NULL,
    order_id text NOT NULL,
    symbol text,
    side text,
    order_status text,
    price numeric(18,4),
    quantity bigint,
    filled_quantity bigint,
    remaining_qty bigint,
    order_time timestamp with time zone,
    trading_date date NOT NULL,
    ingest_source text NOT NULL,
    run_id bigint,
    created_at timestamp with time zone NOT NULL,
    first_seen_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    sighting_count integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    avg_price numeric,
    order_value numeric,
    net_value numeric,
    status_reason text,
    executions_observed integer DEFAULT 1,
    raw jsonb,
    code text,
    order_type text,
    exchange text,
    portfolio text
);


--
-- Name: awsat_order_list_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.awsat_order_list_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: awsat_order_list_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.awsat_order_list_id_seq OWNED BY public.awsat_order_list.id;


--
-- Name: awsat_stock_depth; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.awsat_stock_depth (
    id bigint NOT NULL,
    symbol text NOT NULL,
    level smallint NOT NULL,
    bid numeric(18,4),
    bid_qty bigint,
    bid_orders integer,
    offer numeric(18,4),
    offer_qty bigint,
    offer_orders integer,
    trading_date date NOT NULL,
    ingest_source text NOT NULL,
    run_id bigint,
    created_at timestamp with time zone NOT NULL,
    captured_at timestamp with time zone NOT NULL,
    code text
);


--
-- Name: awsat_stock_depth_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.awsat_stock_depth_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: awsat_stock_depth_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.awsat_stock_depth_id_seq OWNED BY public.awsat_stock_depth.id;


--
-- Name: client_submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_submissions (
    batch_id text NOT NULL,
    ingest_source text NOT NULL,
    kind text NOT NULL,
    captured_at timestamp with time zone,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    rows_offered integer DEFAULT 0 NOT NULL,
    rows_inserted integer DEFAULT 0 NOT NULL,
    rows_rejected integer DEFAULT 0 NOT NULL
);


--
-- Name: depth_watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.depth_watchlist (
    trading_date date NOT NULL,
    slot_no smallint NOT NULL,
    symbol text,
    slot_type text NOT NULL,
    assigned_at timestamp with time zone DEFAULT now(),
    released_at timestamp with time zone,
    assigned_by text,
    replaced text,
    replaced_symbol text,
    replaced_at timestamp with time zone,
    replaced_by text,
    replaced_reason text
);


--
-- Name: instrument_stake; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instrument_stake (
    owner_group text NOT NULL,
    symbol text NOT NULL,
    source text,
    checked_on date
);


--
-- Name: instruments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instruments (
    market text NOT NULL,
    symbol text NOT NULL,
    code text,
    description text,
    first_seen_on date DEFAULT CURRENT_DATE NOT NULL,
    last_seen_on date DEFAULT CURRENT_DATE NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_group text,
    owner_group_ar text,
    group_source text,
    group_checked date,
    superseded_by text,
    market_changed_on date,
    is_primary boolean DEFAULT true,
    broker_status text,
    broker_status_on date,
    tv_status text,
    tv_status_on date,
    is_tradeable boolean
);


--
-- Name: kb_phrase; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_phrase (
    event text NOT NULL,
    text text NOT NULL,
    still_true boolean DEFAULT true NOT NULL
);


--
-- Name: kb_rule; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_rule (
    id bigint NOT NULL,
    rule text NOT NULL,
    scope text NOT NULL,
    symbol text,
    trigger_state text,
    source_cr text,
    added_on date DEFAULT CURRENT_DATE,
    still_true boolean DEFAULT true NOT NULL
);


--
-- Name: kb_rule_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.kb_rule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: kb_rule_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.kb_rule_id_seq OWNED BY public.kb_rule.id;


--
-- Name: kb_threshold; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.kb_threshold (
    key text NOT NULL,
    value numeric NOT NULL,
    unit text,
    source_cr text,
    note text,
    prev_value numeric,
    changed_on date,
    changed_by text,
    still_true boolean DEFAULT true NOT NULL
);


--
-- Name: market_day; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.market_day (
    trading_date date NOT NULL,
    symbols_traded integer,
    advancing integer,
    declining integer,
    unchanged integer,
    pct_advancing numeric,
    breadth_5d_avg numeric,
    avg_pct_change numeric,
    median_pct_change numeric,
    pct_change_p10 numeric,
    pct_change_p90 numeric,
    total_volume bigint,
    total_trades integer,
    volume_vs_20d numeric,
    symbols_over_3x_daily integer,
    new_symbols integer,
    suspended_symbols integer,
    renamed_symbols integer,
    cb_events_total integer,
    regime text,
    computed_at timestamp with time zone DEFAULT now(),
    thin_symbols integer,
    pct_advancing_ratio numeric,
    turnover_kd numeric,
    index_ytd_pct numeric,
    index_close numeric,
    broker_seen_at timestamp with time zone,
    computed_advancing integer,
    computed_declining integer,
    computed_symbols integer
);


--
-- Name: position; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."position" (
    id bigint NOT NULL,
    symbol text NOT NULL,
    trading_date date NOT NULL,
    opened_at timestamp with time zone,
    closed_at timestamp with time zone,
    shares integer,
    avg_cost numeric,
    avg_exit numeric,
    commission numeric,
    net_pnl numeric,
    stop_price numeric,
    is_open boolean DEFAULT true
);


--
-- Name: position_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.position_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: position_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.position_id_seq OWNED BY public."position".id;


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    filename text NOT NULL,
    checksum text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL,
    duration_ms integer
);


--
-- Name: scrape_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scrape_runs (
    id bigint NOT NULL,
    scraper text NOT NULL,
    trading_date date NOT NULL,
    status text DEFAULT 'RUNNING'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    duration_ms integer,
    rows_extracted integer DEFAULT 0 NOT NULL,
    rows_inserted integer DEFAULT 0 NOT NULL,
    rows_rejected integer DEFAULT 0 NOT NULL,
    error_message text,
    error_stack text
);


--
-- Name: scrape_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.scrape_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: scrape_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.scrape_runs_id_seq OWNED BY public.scrape_runs.id;


--
-- Name: signal_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.signal_log (
    id bigint NOT NULL,
    fired_at timestamp with time zone NOT NULL,
    trading_date date NOT NULL,
    symbol text NOT NULL,
    signal text NOT NULL,
    slot smallint,
    price numeric,
    bid_qty bigint,
    offer_qty bigint,
    ratio numeric,
    pace numeric,
    message text,
    replaced text,
    px_5min numeric,
    px_15min numeric,
    px_60min numeric,
    was_right boolean,
    scored_at timestamp with time zone
);


--
-- Name: signal_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.signal_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: signal_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.signal_log_id_seq OWNED BY public.signal_log.id;


--
-- Name: symbol_day; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.symbol_day (
    symbol text NOT NULL,
    trading_date date NOT NULL,
    open_px numeric,
    high_px numeric,
    low_px numeric,
    close_px numeric,
    prev_close numeric,
    chg_fils numeric,
    chg_1d numeric,
    chg_5d numeric,
    day_range numeric,
    series_break boolean DEFAULT false,
    total_volume bigint,
    trades integer,
    avg_trade_size numeric,
    highest_minute_volume bigint,
    vol_ratio_5d numeric,
    trades_baseline_20d numeric,
    moves integer,
    up_moves integer,
    down_moves integer,
    up_moves_2plus integer,
    up_moves_3plus integer,
    up_moves_tiny integer,
    down_moves_tiny integer,
    tiny_pct_up numeric,
    tiny_pct_down numeric,
    trades_under_100 integer,
    last_qty_p10 numeric,
    last_qty_p50 numeric,
    last_qty_p90 numeric,
    bid_p10 numeric,
    bid_p25 numeric,
    bid_p50 numeric,
    bid_p75 numeric,
    bid_p90 numeric,
    offer_p10 numeric,
    offer_p25 numeric,
    offer_p50 numeric,
    offer_p75 numeric,
    offer_p90 numeric,
    spread_fils_p50 numeric,
    spread_fils_p90 numeric,
    pct_postable numeric,
    pct_exitable numeric,
    pct_both_workable numeric,
    exitable_best_hour numeric,
    net_per_fil numeric,
    shares_at_budget integer,
    bought_at_offer bigint,
    sold_at_bid bigint,
    shares_inside_spread bigint,
    trades_at_offer integer,
    trades_at_bid integer,
    buy_sell_ratio numeric,
    block_ratio numeric,
    refill_ratio numeric,
    offer_refilled_n integer,
    offer_rose_n integer,
    bid_consumed_n integer,
    bid_withdrawn_n integer,
    pct_bid_withdrawn numeric,
    wall_events integer,
    wall_max_qty bigint,
    wall_prices jsonb,
    bid_age_p50_secs numeric,
    auction_price numeric,
    auction_volume bigint,
    auction_vs_last_bid numeric,
    tal_price numeric,
    tal_volume bigint,
    cb_events integer,
    cb_total_secs integer,
    best_hour smallint,
    ratio_by_hour jsonb,
    bid_by_hour jsonb,
    offer_by_hour jsonb,
    family text,
    budget_for_queue_kd numeric,
    max_budget_kd numeric,
    minutes_captured integer,
    coverage_pct numeric,
    largest_gap_secs integer,
    data_quality text,
    source text NOT NULL,
    computed_at timestamp with time zone DEFAULT now(),
    pct_at_offer numeric,
    prev_session_used date,
    spread_fils_p10 numeric,
    spread_fils_p25 numeric,
    spread_fils_p75 numeric,
    prev_session_gap_days integer,
    tick_band_crossed boolean,
    close_source text,
    markup numeric,
    resumed integer,
    lift integer,
    hit integer,
    range_source text,
    avg_uptick_shares numeric,
    avg_downtick_shares numeric,
    uptick_ratio numeric,
    n_upticks integer,
    n_downticks integer,
    turnover_kd numeric,
    first_half_shares_per_min numeric,
    second_half_shares_per_min numeric,
    avg_spread_fils numeric,
    avg_spread_pct numeric,
    days_active integer,
    down_days integer,
    peak_hour integer
);


--
-- Name: symbol_minute; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.symbol_minute (
    symbol text NOT NULL,
    ts timestamp with time zone NOT NULL,
    trading_date date NOT NULL,
    last_price numeric,
    bid numeric,
    bid_qty bigint,
    offer numeric,
    offer_qty bigint,
    buyers_per_seller numeric,
    bid_age_secs integer,
    offer_age_secs integer,
    bid_change bigint,
    offer_change bigint,
    wall_event text,
    wall_price numeric,
    wall_qty bigint,
    volume_delta bigint,
    is_frozen boolean,
    source text DEFAULT 'LIVE'::text NOT NULL
);


--
-- Name: tradingview_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tradingview_history (
    symbol text NOT NULL,
    trade_date date NOT NULL,
    open_price numeric(18,4),
    high_price numeric(18,4),
    low_price numeric(18,4),
    close_price numeric(18,4),
    change_value numeric(18,4),
    change_pct numeric(10,4),
    volume bigint,
    session_finalised_at timestamp with time zone,
    run_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tradingview_watchlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tradingview_watchlist (
    id bigint NOT NULL,
    symbol text NOT NULL,
    company_name text,
    last_price numeric(18,4),
    change_value numeric(18,4),
    change_pct numeric(10,4),
    volume bigint,
    avg_volume bigint,
    market_cap numeric(20,2),
    trading_date date NOT NULL,
    scrape_batch_id uuid,
    run_id bigint,
    created_at timestamp with time zone NOT NULL
);


--
-- Name: tradingview_watchlist_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tradingview_watchlist_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tradingview_watchlist_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tradingview_watchlist_id_seq OWNED BY public.tradingview_watchlist.id;


--
-- Name: ai_chat id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chat ALTER COLUMN id SET DEFAULT nextval('public.ai_chat_id_seq'::regclass);


--
-- Name: ai_memory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_memory ALTER COLUMN id SET DEFAULT nextval('public.ai_memory_id_seq'::regclass);


--
-- Name: ai_query_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_query_log ALTER COLUMN id SET DEFAULT nextval('public.ai_query_log_id_seq'::regclass);


--
-- Name: awsat_market_quotes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_market_quotes ALTER COLUMN id SET DEFAULT nextval('public.awsat_market_quotes_id_seq'::regclass);


--
-- Name: awsat_order_list id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_order_list ALTER COLUMN id SET DEFAULT nextval('public.awsat_order_list_id_seq'::regclass);


--
-- Name: awsat_stock_depth id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_stock_depth ALTER COLUMN id SET DEFAULT nextval('public.awsat_stock_depth_id_seq'::regclass);


--
-- Name: kb_rule id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_rule ALTER COLUMN id SET DEFAULT nextval('public.kb_rule_id_seq'::regclass);


--
-- Name: position id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."position" ALTER COLUMN id SET DEFAULT nextval('public.position_id_seq'::regclass);


--
-- Name: scrape_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scrape_runs ALTER COLUMN id SET DEFAULT nextval('public.scrape_runs_id_seq'::regclass);


--
-- Name: signal_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_log ALTER COLUMN id SET DEFAULT nextval('public.signal_log_id_seq'::regclass);


--
-- Name: tradingview_watchlist id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tradingview_watchlist ALTER COLUMN id SET DEFAULT nextval('public.tradingview_watchlist_id_seq'::regclass);


--
-- Name: ai_chat ai_chat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_chat
    ADD CONSTRAINT ai_chat_pkey PRIMARY KEY (id);


--
-- Name: ai_memory ai_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_memory
    ADD CONSTRAINT ai_memory_pkey PRIMARY KEY (id);


--
-- Name: ai_query_log ai_query_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_query_log
    ADD CONSTRAINT ai_query_log_pkey PRIMARY KEY (id);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: awsat_market_quotes awsat_market_quotes_market_symbol_created_at_ingest_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_market_quotes
    ADD CONSTRAINT awsat_market_quotes_market_symbol_created_at_ingest_source_key UNIQUE (market, symbol, created_at, ingest_source);


--
-- Name: awsat_market_quotes awsat_market_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_market_quotes
    ADD CONSTRAINT awsat_market_quotes_pkey PRIMARY KEY (id);


--
-- Name: awsat_market_summary awsat_market_summary_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_market_summary
    ADD CONSTRAINT awsat_market_summary_pkey PRIMARY KEY (captured_at);


--
-- Name: awsat_order_list awsat_order_list_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_order_list
    ADD CONSTRAINT awsat_order_list_order_id_key UNIQUE (order_id);


--
-- Name: awsat_order_list awsat_order_list_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_order_list
    ADD CONSTRAINT awsat_order_list_pkey PRIMARY KEY (id);


--
-- Name: awsat_stock_depth awsat_stock_depth_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_stock_depth
    ADD CONSTRAINT awsat_stock_depth_pkey PRIMARY KEY (id);


--
-- Name: awsat_stock_depth awsat_stock_depth_symbol_level_captured_at_ingest_source_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.awsat_stock_depth
    ADD CONSTRAINT awsat_stock_depth_symbol_level_captured_at_ingest_source_key UNIQUE (symbol, level, captured_at, ingest_source);


--
-- Name: client_submissions client_submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_submissions
    ADD CONSTRAINT client_submissions_pkey PRIMARY KEY (batch_id);


--
-- Name: depth_watchlist depth_watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.depth_watchlist
    ADD CONSTRAINT depth_watchlist_pkey PRIMARY KEY (trading_date, slot_no);


--
-- Name: instrument_stake instrument_stake_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instrument_stake
    ADD CONSTRAINT instrument_stake_pkey PRIMARY KEY (owner_group, symbol);


--
-- Name: instruments instruments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instruments
    ADD CONSTRAINT instruments_pkey PRIMARY KEY (symbol);


--
-- Name: kb_phrase kb_phrase_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_phrase
    ADD CONSTRAINT kb_phrase_pkey PRIMARY KEY (event);


--
-- Name: kb_rule kb_rule_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_rule
    ADD CONSTRAINT kb_rule_pkey PRIMARY KEY (id);


--
-- Name: kb_threshold kb_threshold_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.kb_threshold
    ADD CONSTRAINT kb_threshold_pkey PRIMARY KEY (key);


--
-- Name: market_day market_day_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.market_day
    ADD CONSTRAINT market_day_pkey PRIMARY KEY (trading_date);


--
-- Name: position position_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."position"
    ADD CONSTRAINT position_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (filename);


--
-- Name: scrape_runs scrape_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scrape_runs
    ADD CONSTRAINT scrape_runs_pkey PRIMARY KEY (id);


--
-- Name: signal_log signal_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_log
    ADD CONSTRAINT signal_log_pkey PRIMARY KEY (id);


--
-- Name: signal_log signal_log_symbol_signal_fired_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.signal_log
    ADD CONSTRAINT signal_log_symbol_signal_fired_at_key UNIQUE (symbol, signal, fired_at);


--
-- Name: symbol_day symbol_day_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.symbol_day
    ADD CONSTRAINT symbol_day_pkey PRIMARY KEY (symbol, trading_date);


--
-- Name: symbol_minute symbol_minute_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.symbol_minute
    ADD CONSTRAINT symbol_minute_pkey PRIMARY KEY (symbol, ts);


--
-- Name: tradingview_history tradingview_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tradingview_history
    ADD CONSTRAINT tradingview_history_pkey PRIMARY KEY (symbol, trade_date);


--
-- Name: tradingview_watchlist tradingview_watchlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tradingview_watchlist
    ADD CONSTRAINT tradingview_watchlist_pkey PRIMARY KEY (id);


--
-- Name: tradingview_watchlist tradingview_watchlist_symbol_created_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tradingview_watchlist
    ADD CONSTRAINT tradingview_watchlist_symbol_created_at_key UNIQUE (symbol, created_at);


--
-- PostgreSQL database dump complete
--

\unrestrict A4eREXwpLCCjtKyqJua0sDeEj4kxfXQffh8CrdtI9a76ybXcs7DHRZjI2FKwyBa

