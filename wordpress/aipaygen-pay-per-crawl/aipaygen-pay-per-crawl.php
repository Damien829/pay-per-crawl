<?php
/**
 * Plugin Name:       AIPayGen Pay-per-crawl
 * Plugin URI:        https://aipaygen.com/pay-per-crawl
 * Description:       Charge AI crawlers (GPTBot, ClaudeBot, PerplexityBot...) per page with HTTP 402 and x402 USDC payments, paid straight to your wallet. People and search engines browse free.
 * Version:           2.6.1
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            AIPayGen
 * Author URI:        https://aipaygen.com
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       aipaygen-pay-per-crawl
 *
 * Uses the AIPayGen gateway (https://aipaygen.com) as a third-party service, in the five cases listed in
 * readme.txt ("Third-party service"), which also says what is sent in each.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AIPAYGEN_PPC_GATEWAY', 'https://aipaygen.com' );
// The plugin's own user agent for its calls to AIPayGen (WordPress's default would name this site).
define( 'AIPAYGEN_PPC_UA', 'AIPayGen-WP/2.6.1' );
define( 'AIPAYGEN_PPC_BOTS', '/(GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|GoogleOther|CCBot|Bytespider|Amazonbot|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot|ElevenlabsCrawler|ElevenlabsBot)/i' );

/** A request header, unslashed and sanitized ('' when absent). */
function aipaygen_ppc_header( $name ) {
	$key = 'HTTP_' . strtoupper( str_replace( '-', '_', $name ) );
	return isset( $_SERVER[ $key ] ) ? sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) ) : '';
}

/**
 * Is this address in a range an AI crawler operator publishes (OpenAI, Perplexity, DuckDuckGo,
 * Common Crawl)? Catches crawlers that send a browser user agent. The list is cached for a day;
 * if it can't be fetched, nobody is charged by address.
 */
function aipaygen_ppc_ai_ip( $ip ) {
	if ( ! filter_var( $ip, FILTER_VALIDATE_IP ) ) {
		return false;
	}
	$list = get_transient( 'aipaygen_ppc_ai_ips' );
	if ( false === $list ) {
		$res  = wp_remote_get( AIPAYGEN_PPC_GATEWAY . '/v1/ai_bot_ips?format=text', array( 'timeout' => 5, 'user-agent' => AIPAYGEN_PPC_UA ) );
		$body = is_wp_error( $res ) ? '' : (string) wp_remote_retrieve_body( $res );
		$list = array_values( array_filter( array_map( 'trim', explode( "\n", $body ) ) ) );
		set_transient( 'aipaygen_ppc_ai_ips', $list, $list ? DAY_IN_SECONDS : 15 * MINUTE_IN_SECONDS );
	}
	$bin = inet_pton( $ip );
	foreach ( (array) $list as $cidr ) {
		$parts = explode( '/', (string) $cidr );
		if ( ! filter_var( $parts[0], FILTER_VALIDATE_IP ) ) {
			continue;
		}
		$net = inet_pton( $parts[0] );
		if ( strlen( $net ) !== strlen( $bin ) ) {
			continue;
		}
		$bits  = isset( $parts[1] ) ? max( 0, min( strlen( $net ) * 8, (int) $parts[1] ) ) : strlen( $net ) * 8;
		$bytes = intdiv( $bits, 8 );
		if ( substr( $net, 0, $bytes ) !== substr( $bin, 0, $bytes ) ) {
			continue;
		}
		$rem = $bits % 8;
		if ( 0 === $rem ) {
			return true;
		}
		$mask = chr( ( 0xff << ( 8 - $rem ) ) & 0xff );
		if ( ( $net[ $bytes ] & $mask ) === ( $bin[ $bytes ] & $mask ) ) {
			return true;
		}
	}
	return false;
}

/** Send AI crawlers (and requests already carrying an x402 payment) to the gateway; everyone else is untouched. */
function aipaygen_ppc_maybe_charge() {
	if ( is_admin() || wp_doing_ajax() || wp_doing_cron() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) || is_user_logged_in() ) {
		return;
	}
	$route  = (string) get_option( 'aipaygen_ppc_route', '' );
	$secret = (string) get_option( 'aipaygen_ppc_secret', '' );
	if ( ! preg_match( '/^[0-9a-f]{6,32}$/', $route ) ) {
		return;
	}
	// The gateway fetching a page it was paid for: serve it normally.
	if ( '' !== $secret && hash_equals( $secret, aipaygen_ppc_header( 'x-aipaygen-gateway-secret' ) ) ) {
		return;
	}
	$ua   = aipaygen_ppc_header( 'user-agent' );
	$sig  = aipaygen_ppc_header( 'payment-signature' );
	$xpay = aipaygen_ppc_header( 'x-payment' );
	$ip   = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';
	$path = isset( $_SERVER['REQUEST_URI'] ) ? esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ) : '/';
	if ( '' === $path || '/' !== $path[0] ) {
		$path = '/';
	}
	if ( '' === $sig && '' === $xpay ) {
		$named = preg_match( AIPAYGEN_PPC_BOTS, $ua, $m ) ? $m[0] : '';
		$bot   = '' !== $named ? $named : ( aipaygen_ppc_ai_ip( $ip ) ? 'AI crawler (by IP)' : '' );
		if ( '' === $bot ) {
			aipaygen_ppc_watch( $ip, (string) wp_parse_url( $path, PHP_URL_PATH ), $ua );
			return; // People and search engines browse free.
		}
		// Verified: its name AND its address match the lists AI companies publish. Only verified crawlers
		// get the site's free allowance, so claiming a crawler's name earns nothing.
		$verified = '' !== $named && aipaygen_ppc_ai_ip( $ip );
		// Unpaid AI crawler: answer with the price here; it never reaches AIPayGen.
		aipaygen_ppc_count( aipaygen_ppc_seen_as( $named, $verified, $route ), (string) wp_parse_url( $path, PHP_URL_PATH ) );
		aipaygen_ppc_local_402( $route, home_url( $path ), $bot, $verified );
		return; // No quote, report only, or within the free allowance: serve the page as usual.
	}

	$headers = array(
		'user-agent' => $ua,
		'accept'     => aipaygen_ppc_header( 'accept' ) ? aipaygen_ppc_header( 'accept' ) : '*/*',
	);
	if ( '' !== $sig ) {
		$headers['payment-signature'] = $sig;
	}
	if ( '' !== $xpay ) {
		$headers['x-payment'] = $xpay;
	}
	// A crawler retrying with a payment: AIPayGen verifies it, fetches the page and settles to your wallet.
	$res = wp_remote_get(
		AIPAYGEN_PPC_GATEWAY . '/g/' . $route . $path,
		array(
			'headers'     => $headers,
			'timeout'     => 25,
			'redirection' => 0,
		)
	);
	if ( is_wp_error( $res ) ) {
		return; // Gateway unreachable: serve the page as usual rather than fail.
	}

	$code = (int) wp_remote_retrieve_response_code( $res );
	// link: the gateway's 402 links the route's AI Terms, and a relayed 402 must keep it.
	// x-aipaygen-charged and x-aipaygen-delivery tell the buyer's software whether it paid; a paid page also
	// keeps the gateway's Content-Usage, AI-Purpose and review headers.
	$keep = array( 'payment-response', 'cache-control', 'link', 'x-aipaygen-charged', 'x-aipaygen-delivery' );
	$keep = array_merge( $keep, ( $code >= 200 && $code <= 299 ) ? array( 'content-usage', 'ai-purpose', 'x-aipaygen-review' ) : array( 'payment-required' ) );
	foreach ( $keep as $h ) {
		$v = wp_remote_retrieve_header( $res, $h );
		if ( '' !== $v ) {
			header( $h . ': ' . str_replace( array( "\r", "\n" ), '', is_array( $v ) ? implode( ', ', $v ) : $v ) );
		}
	}
	if ( $code >= 200 && $code <= 299 ) {
		// Paid: AIPayGen verified the payment, fetched this page and settled it. WordPress now serves the
		// page itself, as for any visitor, with the payment receipt header added. Nothing from the
		// gateway's body is printed.
		return;
	}
	// Anything else (a 402 with a new quote, or an error) is the gateway's JSON answer: decoded here and
	// encoded again, so only JSON is ever printed.
	$answer = json_decode( (string) wp_remote_retrieve_body( $res ), true );
	status_header( $code );
	header( 'content-type: application/json' );
	echo wp_json_encode( is_array( $answer ) ? $answer : array( 'error' => 'gateway_error' ) );
	exit;
}
add_action( 'init', 'aipaygen_ppc_maybe_charge', 0 );

/**
 * This site's AI Terms at /.well-known/ai-terms: the route's terms from AIPayGen, kept 15 minutes. Serving them is
 * also how AIPayGen confirms you control this site (only the site's owner can make it serve this route's terms), so
 * no DNS record or file is needed. If AIPayGen can't be reached, WordPress answers that address as it normally would,
 * and the next try waits 5 minutes.
 */
function aipaygen_ppc_serve_terms() {
	$route = (string) get_option( 'aipaygen_ppc_route', '' );
	if ( ! preg_match( '/^[0-9a-f]{6,32}$/', $route ) ) {
		return;
	}
	$path = isset( $_SERVER['REQUEST_URI'] ) ? (string) wp_parse_url( esc_url_raw( wp_unslash( $_SERVER['REQUEST_URI'] ) ), PHP_URL_PATH ) : '';
	if ( '/.well-known/ai-terms' !== $path ) {
		return;
	}
	$kept = get_transient( 'aipaygen_ppc_terms' );
	if ( ! is_array( $kept ) || ! isset( $kept['route'], $kept['body'] ) || $kept['route'] !== $route ) {
		$res  = wp_remote_get( AIPAYGEN_PPC_GATEWAY . '/v1/gateway/terms/' . $route, array( 'timeout' => 3, 'redirection' => 0, 'user-agent' => AIPAYGEN_PPC_UA ) );
		$body = ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) ? (string) wp_remote_retrieve_body( $res ) : '';
		$ok   = '' !== $body && strlen( $body ) <= 65536 && is_array( json_decode( $body, true ) );
		$kept = array( 'route' => $route, 'body' => $ok ? $body : '' );
		set_transient( 'aipaygen_ppc_terms', $kept, $ok ? 15 * MINUTE_IN_SECONDS : 5 * MINUTE_IN_SECONDS );
	}
	$terms = '' === $kept['body'] ? null : json_decode( $kept['body'], true );
	if ( ! is_array( $terms ) ) {
		return;
	}
	status_header( 200 );
	header( 'content-type: application/json' );
	header( 'cache-control: public, max-age=900' );
	header( 'access-control-allow-origin: *' );
	// Decoded above and encoded again here, so only JSON is ever printed.
	echo wp_json_encode( $terms );
	exit;
}
add_action( 'init', 'aipaygen_ppc_serve_terms', -1 );

/** This route's price quote from AIPayGen, cached for an hour (false if unavailable). */
function aipaygen_ppc_quote( $route ) {
	$q = get_transient( 'aipaygen_ppc_quote' );
	if ( is_array( $q ) && isset( $q['route'] ) && $q['route'] === $route ) {
		return $q;
	}
	// No usable quote a moment ago: wait 5 minutes before asking again, so crawler visits never each trigger a lookup.
	if ( get_transient( 'aipaygen_ppc_quote_miss' ) === $route ) {
		return false;
	}
	$res = wp_remote_get( AIPAYGEN_PPC_GATEWAY . '/v1/gateway/quote/' . $route, array( 'timeout' => 5, 'user-agent' => AIPAYGEN_PPC_UA ) );
	$q   = is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ? null : json_decode( (string) wp_remote_retrieve_body( $res ), true );
	// Report-only routes (charge_mode off) have no price: cache them too, so pages are served without a lookup.
	if ( ! is_array( $q ) || ( empty( $q['accepts'] ) && ( ! isset( $q['charge_mode'] ) || 'off' !== $q['charge_mode'] ) ) ) {
		set_transient( 'aipaygen_ppc_quote_miss', $route, 5 * MINUTE_IN_SECONDS );
		return false;
	}
	$q['route'] = $route;
	set_transient( 'aipaygen_ppc_quote', $q, HOUR_IN_SECONDS );
	return $q;
}

/** Answer an unpaid AI crawler with HTTP 402 and the route's price, then stop. Returns (page served) if no quote or the bot is let in free. */
/**
 * AI Terms: a 402 should link the terms it is answering under. The route's terms URL comes with the
 * quote; it is used only when it is a plain https URL (no space, quote or angle bracket), else ''.
 */
function aipaygen_ppc_terms_link( $q ) {
	$terms = is_array( $q ) && isset( $q['terms'] ) && is_string( $q['terms'] ) ? $q['terms'] : '';
	return preg_match( '#^https:[^\s<>"]+\z#', $terms ) ? '<' . $terms . '>; rel="ai-terms"' : '';
}

function aipaygen_ppc_local_402( $route, $url, $bot = '', $verified = false ) {
	$q = aipaygen_ppc_quote( $route );
	if ( ! $q || ( isset( $q['charge_mode'] ) && 'off' === $q['charge_mode'] ) ) {
		return; // No quote, or report only: serve the page (the visit is already counted).
	}
	// Bots this site lets in free (its route's settings, e.g. AI search in "training" mode).
	foreach ( ( isset( $q['free_bots'] ) && is_array( $q['free_bots'] ) ) ? $q['free_bots'] : array() as $free ) {
		if ( 0 === strcasecmp( (string) $free, (string) $bot ) ) {
			return;
		}
	}
	// Free allowance (AI Terms "free"): this many pages per UTC hour or day for each verified crawler, then
	// the price. Counted in a transient that every PHP process shares; two requests at the same moment can
	// let one extra page in, never fewer.
	$fa = ( isset( $q['free'] ) && is_array( $q['free'] ) ) ? $q['free'] : null;
	if ( $verified && $fa && isset( $fa['requests'] ) && (int) $fa['requests'] > 0 ) {
		$hourly = isset( $fa['per'] ) && 'hour' === $fa['per'];
		$key    = 'aipaygen_ppc_free_' . md5( strtolower( (string) $bot ) . '|' . gmdate( 'Y-m-d' ) . ( $hourly ? 'T' . gmdate( 'H' ) : '' ) );
		$used   = (int) get_transient( $key ) + 1;
		set_transient( $key, $used, $hourly ? 2 * HOUR_IN_SECONDS : 2 * DAY_IN_SECONDS );
		if ( $used <= (int) $fa['requests'] ) {
			return;
		}
	}
	$quote = array(
		'x402Version' => 2,
		'error'       => 'PAYMENT_REQUIRED',
		'resource'    => array(
			'url'         => esc_url_raw( $url ),
			'description' => isset( $q['description'] ) ? (string) $q['description'] : '',
			'mimeType'    => 'text/html',
		),
		'accepts'     => $q['accepts'],
	);
	// The quote's x402 v2 extensions (AI Terms, ask before you buy), kept where the official SDK keeps them.
	if ( isset( $q['extensions'] ) && is_array( $q['extensions'] ) && $q['extensions'] ) {
		$quote['extensions'] = $q['extensions'];
	}
	status_header( 402 );
	header( 'content-type: application/json' );
	header( 'cache-control: no-store' );
	header( 'payment-required: ' . base64_encode( wp_json_encode( $quote ) ) );
	$link = aipaygen_ppc_terms_link( $q );
	if ( '' !== $link ) {
		header( 'link: ' . $link );
	}
	echo wp_json_encode( array_merge( $quote, array( 'help' => isset( $q['help'] ) ? $q['help'] : null ) ) );
	exit;
}

/**
 * The name a visit is counted under: "<name> (fake)" when the name's operator publishes its addresses (the quote's
 * checked_bots) and the visit came from outside the address list, once that list has loaded. Names with no
 * published list are never called fake. One list covers every operator, so a name used from another AI company's
 * addresses still counts as real: fakes can be under-counted, never over-counted.
 */
function aipaygen_ppc_seen_as( $named, $verified, $route ) {
	if ( '' === $named ) {
		return 'AI crawler (by IP)';
	}
	$list = get_transient( 'aipaygen_ppc_ai_ips' );
	$q    = aipaygen_ppc_quote( $route );
	if ( $verified || ! is_array( $list ) || ! $list || ! is_array( $q ) || ! isset( $q['checked_bots'] ) || ! is_array( $q['checked_bots'] ) ) {
		return $named;
	}
	foreach ( $q['checked_bots'] as $b ) {
		if ( is_string( $b ) && 0 === strcasecmp( $b, $named ) ) {
			return $b . ' (fake)';
		}
	}
	return $named;
}

/** Count one AI crawler visit for the report (kept in an option, sent hourly). */
function aipaygen_ppc_count( $bot, $path ) {
	$c = get_option( 'aipaygen_ppc_counts', array() );
	if ( ! is_array( $c ) ) {
		$c = array();
	}
	$c['bots'][ $bot ] = ( isset( $c['bots'][ $bot ] ) ? (int) $c['bots'][ $bot ] : 0 ) + 1;
	if ( '' !== $path && ( isset( $c['paths'][ $path ] ) || count( isset( $c['paths'] ) ? $c['paths'] : array() ) < 300 ) ) {
		$c['paths'][ $path ] = ( isset( $c['paths'][ $path ] ) ? (int) $c['paths'][ $path ] : 0 ) + 1;
	}
	update_option( 'aipaygen_ppc_counts', $c, false );
}

/**
 * Fast readers: a browser user agent asking for many pages a minute, often a crawler that doesn't
 * say what it is. Only listed in the report (network /24 or /48 and user agent), never charged.
 * Needs a persistent object cache (Redis, Memcached), so normal visits never write to the database.
 */
function aipaygen_ppc_watch( $ip, $path, $ua ) {
	if ( ! wp_using_ext_object_cache() || preg_match( '/\.(css|js|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf)$/i', $path ) ) {
		return;
	}
	if ( ! filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
		return; // Not an address, or a private one: likely a proxy, not a visitor.
	}
	$bin = inet_pton( $ip );
	if ( 4 === strlen( $bin ) ) {
		$net = implode( '.', array_slice( explode( '.', inet_ntop( $bin ) ), 0, 3 ) ) . '.0/24';
	} else {
		$g   = unpack( 'n3', substr( $bin, 0, 6 ) );
		$net = dechex( $g[1] ) . ':' . dechex( $g[2] ) . ':' . dechex( $g[3] ) . '::/48';
	}
	$q     = aipaygen_ppc_quote( (string) get_option( 'aipaygen_ppc_route', '' ) );
	$limit = is_array( $q ) && isset( $q['fast']['pages'], $q['fast']['seconds'] ) ? $q['fast'] : array( 'pages' => 60, 'seconds' => 60 );
	$key   = 'w' . md5( $ip );
	$n     = wp_cache_incr( $key, 1, 'aipaygen_ppc' );
	if ( false === $n ) {
		wp_cache_set( $key, 1, 'aipaygen_ppc', (int) $limit['seconds'] );
		return;
	}
	if ( (int) $n !== (int) $limit['pages'] ) {
		return; // Under the limit, or already flagged in this window.
	}
	$c = get_option( 'aipaygen_ppc_counts', array() );
	if ( ! is_array( $c ) ) {
		$c = array();
	}
	if ( isset( $c['fast'][ $net ] ) || count( isset( $c['fast'] ) ? $c['fast'] : array() ) < 20 ) {
		$f                 = isset( $c['fast'][ $net ] ) ? $c['fast'][ $net ] : array( 'pages' => 0, 'times' => 0 );
		$c['fast'][ $net ] = array(
			'pages' => max( (int) $f['pages'], (int) $n ),
			'times' => (int) $f['times'] + 1,
			'ua'    => substr( $ua, 0, 160 ),
		);
		update_option( 'aipaygen_ppc_counts', $c, false );
	}
}

/** Send the stored counts to AIPayGen (hourly, by WP-Cron) and clear them once accepted. */
function aipaygen_ppc_send_counts() {
	$route  = (string) get_option( 'aipaygen_ppc_route', '' );
	$secret = (string) get_option( 'aipaygen_ppc_secret', '' );
	$c      = get_option( 'aipaygen_ppc_counts', array() );
	if ( '' === $route || '' === $secret || ! is_array( $c ) || ( empty( $c['bots'] ) && empty( $c['fast'] ) ) ) {
		return;
	}
	$paths = isset( $c['paths'] ) && is_array( $c['paths'] ) ? $c['paths'] : array();
	arsort( $paths );
	$res = wp_remote_post(
		AIPAYGEN_PPC_GATEWAY . '/v1/gateway/hits/' . $route,
		array(
			'timeout'    => 10,
			'user-agent' => AIPAYGEN_PPC_UA,
			'headers'    => array(
				'content-type'              => 'application/json',
				'x-aipaygen-gateway-secret' => $secret,
			),
			'body'    => wp_json_encode(
				array(
					'counts' => (object) ( isset( $c['bots'] ) ? $c['bots'] : array() ),
					'paths'  => (object) array_slice( $paths, 0, 10, true ),
					'fast'   => (object) ( isset( $c['fast'] ) ? $c['fast'] : array() ),
				)
			),
		)
	);
	if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
		delete_option( 'aipaygen_ppc_counts' );
	}
}
add_action( 'aipaygen_ppc_send_counts', 'aipaygen_ppc_send_counts' );

function aipaygen_ppc_schedule() {
	if ( ! wp_next_scheduled( 'aipaygen_ppc_send_counts' ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'hourly', 'aipaygen_ppc_send_counts' );
	}
}
add_action( 'init', 'aipaygen_ppc_schedule' );

/** The private link to this site's AI crawler report (derived from the gateway secret). */
function aipaygen_ppc_report_url() {
	$route  = (string) get_option( 'aipaygen_ppc_route', '' );
	$secret = (string) get_option( 'aipaygen_ppc_secret', '' );
	if ( '' === $route || '' === $secret ) {
		return '';
	}
	return AIPAYGEN_PPC_GATEWAY . '/pay-per-crawl/report/' . $route . '?t=' . substr( hash( 'sha256', $secret . ':report' ), 0, 24 );
}

function aipaygen_ppc_admin_menu() {
	add_options_page(
		__( 'AIPayGen pay-per-crawl', 'aipaygen-pay-per-crawl' ),
		__( 'AIPayGen pay-per-crawl', 'aipaygen-pay-per-crawl' ),
		'manage_options',
		'aipaygen-pay-per-crawl',
		'aipaygen_ppc_settings_page'
	);
}
add_action( 'admin_menu', 'aipaygen_ppc_admin_menu' );

function aipaygen_ppc_sanitize_route( $v ) {
	$v = strtolower( trim( (string) $v ) );
	return preg_match( '/^[0-9a-f]{6,32}$/', $v ) ? $v : '';
}

function aipaygen_ppc_sanitize_secret( $v ) {
	return preg_replace( '/[^A-Za-z0-9]/', '', (string) $v );
}

function aipaygen_ppc_register_settings() {
	register_setting( 'aipaygen_ppc', 'aipaygen_ppc_route', array( 'type' => 'string', 'sanitize_callback' => 'aipaygen_ppc_sanitize_route', 'default' => '' ) );
	register_setting( 'aipaygen_ppc', 'aipaygen_ppc_secret', array( 'type' => 'string', 'sanitize_callback' => 'aipaygen_ppc_sanitize_secret', 'default' => '' ) );
}
add_action( 'admin_init', 'aipaygen_ppc_register_settings' );

function aipaygen_ppc_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	?>
	<div class="wrap">
		<h1><?php echo esc_html__( 'AIPayGen pay-per-crawl', 'aipaygen-pay-per-crawl' ); ?></h1>
		<p>
			<?php echo esc_html__( 'Create a free route for this site (no wallet needed to start with the report; add one when you want to charge), then paste the route id and gateway secret here:', 'aipaygen-pay-per-crawl' ); ?>
			<a href="<?php echo esc_url( AIPAYGEN_PPC_GATEWAY . '/pay-per-crawl#signup' ); ?>" target="_blank" rel="noopener"><?php echo esc_html__( 'create a route', 'aipaygen-pay-per-crawl' ); ?></a>
		</p>
		<form method="post" action="options.php">
			<?php settings_fields( 'aipaygen_ppc' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="aipaygen_ppc_route"><?php echo esc_html__( 'Route id', 'aipaygen-pay-per-crawl' ); ?></label></th>
					<td><input id="aipaygen_ppc_route" name="aipaygen_ppc_route" class="regular-text" value="<?php echo esc_attr( get_option( 'aipaygen_ppc_route', '' ) ); ?>" placeholder="3f9a1c0b7d2e"></td>
				</tr>
				<tr>
					<th scope="row"><label for="aipaygen_ppc_secret"><?php echo esc_html__( 'Gateway secret', 'aipaygen-pay-per-crawl' ); ?></label></th>
					<td><input id="aipaygen_ppc_secret" name="aipaygen_ppc_secret" type="password" class="regular-text" value="<?php echo esc_attr( get_option( 'aipaygen_ppc_secret', '' ) ); ?>" autocomplete="off"></td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
		<?php if ( aipaygen_ppc_report_url() ) : ?>
			<p>
				<?php echo esc_html__( 'See which AI crawlers visit and what they would pay:', 'aipaygen-pay-per-crawl' ); ?>
				<a href="<?php echo esc_url( aipaygen_ppc_report_url() ); ?>" target="_blank" rel="noopener"><?php echo esc_html__( 'your AI crawler report', 'aipaygen-pay-per-crawl' ); ?></a>
				<?php echo esc_html__( '(keep this link private; counts arrive hourly)', 'aipaygen-pay-per-crawl' ); ?>
			</p>
		<?php endif; ?>
		<?php
		$aipaygen_ppc_q = get_option( 'aipaygen_ppc_route', '' ) ? aipaygen_ppc_quote( (string) get_option( 'aipaygen_ppc_route', '' ) ) : false;
		$aipaygen_ppc_off = is_array( $aipaygen_ppc_q ) && isset( $aipaygen_ppc_q['charge_mode'] ) && 'off' === $aipaygen_ppc_q['charge_mode'];
		?>
		<?php if ( $aipaygen_ppc_off ) : ?>
			<p><?php echo esc_html__( 'Report-only mode: AI crawlers still get your pages and are counted for the report. To start charging, add your wallet to the route (the report shows how); this plugin picks it up within an hour.', 'aipaygen-pay-per-crawl' ); ?></p>
		<?php else : ?>
			<p>
				<?php echo esc_html__( 'Check it from a terminal; it should answer 402 with your price:', 'aipaygen-pay-per-crawl' ); ?>
				<code>curl -i -A GPTBot <?php echo esc_html( home_url( '/' ) ); ?></code>
			</p>
		<?php endif; ?>
	</div>
	<?php
}

/**
 * A personal download (built in the browser on aipaygen.com from this same plugin) adds
 * aipaygen-setup.php with the site's route id and gateway secret. Copy them into the settings once,
 * then delete the file. Runs on activation, and on the next admin page for an upload that replaced
 * an active copy. If the file can't be deleted, its hash is kept so it is never applied twice.
 */
function aipaygen_ppc_import_setup() {
	$file = __DIR__ . '/aipaygen-setup.php';
	if ( ! file_exists( $file ) ) {
		return;
	}
	$hash = (string) md5_file( $file );
	if ( get_option( 'aipaygen_ppc_setup_applied', '' ) !== $hash ) {
		$data   = include $file;
		$route  = is_array( $data ) && isset( $data['route'] ) ? aipaygen_ppc_sanitize_route( $data['route'] ) : '';
		$secret = is_array( $data ) && isset( $data['secret'] ) ? aipaygen_ppc_sanitize_secret( $data['secret'] ) : '';
		if ( '' !== $route && '' !== $secret ) {
			update_option( 'aipaygen_ppc_route', $route );
			update_option( 'aipaygen_ppc_secret', $secret );
			delete_transient( 'aipaygen_ppc_quote' );
		}
		update_option( 'aipaygen_ppc_setup_applied', $hash );
	}
	wp_delete_file( $file );
}
register_activation_hook( __FILE__, 'aipaygen_ppc_import_setup' );
add_action( 'admin_init', 'aipaygen_ppc_import_setup' );

function aipaygen_ppc_uninstall() {
	delete_option( 'aipaygen_ppc_route' );
	delete_option( 'aipaygen_ppc_secret' );
	delete_transient( 'aipaygen_ppc_ai_ips' );
	delete_transient( 'aipaygen_ppc_quote' );
	delete_transient( 'aipaygen_ppc_terms' );
	delete_option( 'aipaygen_ppc_counts' );
	delete_option( 'aipaygen_ppc_setup_applied' );
	wp_clear_scheduled_hook( 'aipaygen_ppc_send_counts' );
}
register_uninstall_hook( __FILE__, 'aipaygen_ppc_uninstall' );
