<?php
/**
 * Plugin Name:       AIPayGen Pay-per-crawl
 * Plugin URI:        https://aipaygen.com/pay-per-crawl
 * Description:       Charge AI crawlers (GPTBot, ClaudeBot, PerplexityBot...) per page with HTTP 402 and x402 USDC payments, paid straight to your wallet. People and search engines browse free.
 * Version:           2.0.0
 * Requires at least: 5.6
 * Requires PHP:      7.4
 * Author:            AIPayGen
 * Author URI:        https://aipaygen.com
 * License:           GPLv2 or later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       aipaygen-pay-per-crawl
 *
 * Uses the AIPayGen gateway (https://aipaygen.com) as a third-party service, only for requests from
 * known AI crawlers or requests carrying an x402 payment. See readme.txt for what is sent.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AIPAYGEN_PPC_GATEWAY', 'https://aipaygen.com' );
define( 'AIPAYGEN_PPC_BOTS', '/(GPTBot|OAI\-SearchBot|ChatGPT\-User|ClaudeBot|Claude\-User|Claude\-SearchBot|anthropic\-ai|PerplexityBot|Perplexity\-User|Google\-Extended|GoogleOther|CCBot|Bytespider|Amazonbot|Applebot\-Extended|meta\-externalagent|FacebookBot|cohere\-ai|Diffbot|YouBot|MistralAI\-User|DuckAssistBot|PetalBot|Timpibot|ImagesiftBot|omgili|AI2Bot|ElevenlabsCrawler|ElevenlabsBot)/i' );

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
		$res  = wp_remote_get( AIPAYGEN_PPC_GATEWAY . '/v1/ai_bot_ips?format=text', array( 'timeout' => 5 ) );
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
		$bot = preg_match( AIPAYGEN_PPC_BOTS, $ua, $m ) ? $m[0] : ( aipaygen_ppc_ai_ip( $ip ) ? 'AI crawler (by IP)' : '' );
		if ( '' === $bot ) {
			return; // People and search engines browse free.
		}
		// Unpaid AI crawler: answer with the price here; it never reaches AIPayGen.
		aipaygen_ppc_count( $bot, (string) wp_parse_url( $path, PHP_URL_PATH ) );
		aipaygen_ppc_local_402( $route, home_url( $path ) );
		return; // No quote available right now: serve the page as usual.
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

	status_header( (int) wp_remote_retrieve_response_code( $res ) );
	foreach ( array( 'content-type', 'payment-required', 'payment-response', 'cache-control' ) as $h ) {
		$v = wp_remote_retrieve_header( $res, $h );
		if ( '' !== $v ) {
			header( $h . ': ' . str_replace( array( "\r", "\n" ), '', is_array( $v ) ? implode( ', ', $v ) : $v ) );
		}
	}
	// The body is either the gateway's JSON payment quote or this site's own page (fetched by the
	// gateway after payment), returned to the crawler unchanged, so it must not be escaped.
	echo wp_remote_retrieve_body( $res ); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
	exit;
}
add_action( 'init', 'aipaygen_ppc_maybe_charge', 0 );

/** This route's price quote from AIPayGen, cached for an hour (false if unavailable). */
function aipaygen_ppc_quote( $route ) {
	$q = get_transient( 'aipaygen_ppc_quote' );
	if ( is_array( $q ) && isset( $q['route'] ) && $q['route'] === $route ) {
		return $q;
	}
	$res = wp_remote_get( AIPAYGEN_PPC_GATEWAY . '/v1/gateway/quote/' . $route, array( 'timeout' => 5 ) );
	$q   = is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ? null : json_decode( (string) wp_remote_retrieve_body( $res ), true );
	if ( ! is_array( $q ) || empty( $q['accepts'] ) ) {
		return false;
	}
	$q['route'] = $route;
	set_transient( 'aipaygen_ppc_quote', $q, HOUR_IN_SECONDS );
	return $q;
}

/** Answer an unpaid AI crawler with HTTP 402 and the route's price, then stop. Returns if no quote. */
function aipaygen_ppc_local_402( $route, $url ) {
	$q = aipaygen_ppc_quote( $route );
	if ( ! $q ) {
		return;
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
	status_header( 402 );
	header( 'content-type: application/json' );
	header( 'cache-control: no-store' );
	header( 'payment-required: ' . base64_encode( wp_json_encode( $quote ) ) );
	echo wp_json_encode( array_merge( $quote, array( 'help' => isset( $q['help'] ) ? $q['help'] : null ) ) );
	exit;
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

/** Send the stored counts to AIPayGen (hourly, by WP-Cron) and clear them once accepted. */
function aipaygen_ppc_send_counts() {
	$route  = (string) get_option( 'aipaygen_ppc_route', '' );
	$secret = (string) get_option( 'aipaygen_ppc_secret', '' );
	$c      = get_option( 'aipaygen_ppc_counts', array() );
	if ( '' === $route || '' === $secret || ! is_array( $c ) || empty( $c['bots'] ) ) {
		return;
	}
	$paths = isset( $c['paths'] ) && is_array( $c['paths'] ) ? $c['paths'] : array();
	arsort( $paths );
	$res = wp_remote_post(
		AIPAYGEN_PPC_GATEWAY . '/v1/gateway/hits/' . $route,
		array(
			'timeout' => 10,
			'headers' => array(
				'content-type'              => 'application/json',
				'x-aipaygen-gateway-secret' => $secret,
			),
			'body'    => wp_json_encode(
				array(
					'counts' => $c['bots'],
					'paths'  => (object) array_slice( $paths, 0, 10, true ),
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
			<?php echo esc_html__( 'Create a free route for this site (your price per page and your wallet), then paste the route id and gateway secret here:', 'aipaygen-pay-per-crawl' ); ?>
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
		<p>
			<?php echo esc_html__( 'Check it from a terminal; it should answer 402 with your price:', 'aipaygen-pay-per-crawl' ); ?>
			<code>curl -i -A GPTBot <?php echo esc_html( home_url( '/' ) ); ?></code>
		</p>
	</div>
	<?php
}

function aipaygen_ppc_uninstall() {
	delete_option( 'aipaygen_ppc_route' );
	delete_option( 'aipaygen_ppc_secret' );
	delete_transient( 'aipaygen_ppc_ai_ips' );
	delete_transient( 'aipaygen_ppc_quote' );
	delete_option( 'aipaygen_ppc_counts' );
	wp_clear_scheduled_hook( 'aipaygen_ppc_send_counts' );
}
register_uninstall_hook( __FILE__, 'aipaygen_ppc_uninstall' );
