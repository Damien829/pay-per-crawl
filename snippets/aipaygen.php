<?php
/**
 * aipaygen.php: pay-per-crawl for PHP and Laravel via AIPayGen (PHP 7.4+).
 * 1. Save this file next to your front controller (Laravel: public/aipaygen.php).
 * 2. At the very top of that front controller (Laravel: public/index.php), right after the <?php line, add:
 *        define( 'AIPAYGEN_SECRET', 'the gateway secret you got at sign-up' );
 *        require __DIR__ . '/aipaygen.php';
 *    (Or set AIPAYGEN_SECRET in the server's environment instead of the define.)
 * 3. Behind a proxy or load balancer, also add define( 'AIPAYGEN_TRUSTED_PROXIES', '10.0.0.1,10.0.0.0/8' ) before the require:
 *    only then is the visitor's address read from X-Forwarded-For (anyone can send that header, so otherwise it is ignored).
 * People and search engines browse free. Report-only routes count AI crawlers and still serve the page. If anything in this
 * file fails, the page is served as if it were not here. State is kept in a private folder (AIPAYGEN_DIR, default: your
 * system's temp folder); no personal data is stored there.
 */
if ( defined( 'AIPAYGEN_LOADED' ) ) {
	return;
}
define( 'AIPAYGEN_LOADED', 1 );
define( 'APG_GATEWAY', 'https://aipaygen.com' );
define( 'APG_ROUTE_DEFAULT', 'YOUR_ROUTE_ID' );
define( 'APG_UA', 'aipaygen-php/1' );
define( 'APG_BOTS', '/(' . implode( '|', array_map( function ( $b ) { return preg_quote( $b, '/' ); }, array( 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'GoogleOther', 'CCBot', 'Bytespider', 'Amazonbot', 'meta-externalagent', 'FacebookBot', 'cohere-ai', 'Diffbot', 'YouBot', 'MistralAI-User', 'DuckAssistBot', 'PetalBot', 'Timpibot', 'ImagesiftBot', 'omgili', 'AI2Bot', 'ElevenlabsCrawler', 'ElevenlabsBot' ) ) ) . ')/i' );

/** The response's headers and status go through these two (a test replaces them). */
if ( ! function_exists( 'apg_out' ) ) {
	function apg_out( $line, $replace = true ) {
		header( $line, $replace );
	}
	function apg_status( $code ) {
		http_response_code( $code );
	}
}

function apg_route() {
	$r = defined( 'AIPAYGEN_ROUTE' ) ? (string) AIPAYGEN_ROUTE : ( getenv( 'AIPAYGEN_ROUTE' ) ? (string) getenv( 'AIPAYGEN_ROUTE' ) : APG_ROUTE_DEFAULT );
	return preg_match( '/^[0-9a-f]{6,32}$/', $r ) ? $r : '';
}

function apg_secret() {
	if ( defined( 'AIPAYGEN_SECRET' ) ) {
		return (string) AIPAYGEN_SECRET;
	}
	$s = getenv( 'AIPAYGEN_SECRET' );
	if ( false !== $s && '' !== $s ) {
		return (string) $s;
	}
	return isset( $_SERVER['AIPAYGEN_SECRET'] ) ? (string) $_SERVER['AIPAYGEN_SECRET'] : '';
}

function apg_header( $name ) {
	$key = 'HTTP_' . strtoupper( str_replace( '-', '_', $name ) );
	return isset( $_SERVER[ $key ] ) ? trim( (string) $_SERVER[ $key ] ) : '';
}

/** The private folder for this site's small state files ('' if none can be made: then nothing is cached or counted). */
function apg_dir() {
	static $d = null;
	if ( null !== $d ) {
		return $d;
	}
	$base = defined( 'AIPAYGEN_DIR' ) ? (string) AIPAYGEN_DIR : ( getenv( 'AIPAYGEN_DIR' ) ? (string) getenv( 'AIPAYGEN_DIR' ) : sys_get_temp_dir() . '/aipaygen-' . substr( md5( __FILE__ ), 0, 12 ) );
	if ( ! is_dir( $base ) ) {
		@mkdir( $base, 0700, true );
	}
	// The folder must be ours and closed to other users: on shared hosting another local user could pre-create a predictable
	// folder and plant a quote or address list in it. Anything else: nothing is cached or counted, and nothing is written there.
	$me   = function_exists( 'posix_geteuid' ) ? posix_geteuid() : getmyuid();
	$mine = is_dir( $base ) && is_writable( $base ) && false !== $me && fileowner( $base ) === $me && 0 === ( fileperms( $base ) & 0022 );
	$d    = $mine ? rtrim( $base, '/' ) : '';
	return $d;
}

function apg_file( $k ) {
	$d = apg_dir();
	return '' === $d ? '' : $d . '/' . md5( $k ) . '.json';
}

/** A kept value, or null when missing, expired or unreadable. */
function apg_get( $k ) {
	$f = apg_file( $k );
	if ( '' === $f || ! is_file( $f ) ) {
		return null;
	}
	$j = json_decode( (string) @file_get_contents( $f ), true );
	return ( is_array( $j ) && isset( $j['e'] ) && $j['e'] > time() && array_key_exists( 'v', $j ) ) ? $j['v'] : null;
}

function apg_set( $k, $v, $ttl ) {
	$f = apg_file( $k );
	if ( '' !== $f ) {
		@file_put_contents( $f, json_encode( array( 'e' => time() + (int) $ttl, 'v' => $v ) ), LOCK_EX );
	}
}

/** Read, change and write back one kept value under a lock, so parallel requests don't lose each other's counts. */
function apg_update( $k, $fn, $ttl ) {
	$f = apg_file( $k );
	if ( '' === $f ) {
		return;
	}
	$h = @fopen( $f, 'c+' );
	if ( ! $h ) {
		return;
	}
	if ( flock( $h, LOCK_EX ) ) {
		$j   = json_decode( (string) stream_get_contents( $h ), true );
		$cur = ( is_array( $j ) && isset( $j['e'] ) && $j['e'] > time() && array_key_exists( 'v', $j ) ) ? $j['v'] : null;
		$new = $fn( $cur );
		ftruncate( $h, 0 );
		rewind( $h );
		fwrite( $h, json_encode( array( 'e' => time() + (int) $ttl, 'v' => $new ) ) );
		fflush( $h );
		flock( $h, LOCK_UN );
	}
	fclose( $h );
}

/** One HTTP request: array( status, lowercase headers, body ), or null when it could not be made. Never follows redirects. */
if ( ! function_exists( 'apg_http' ) ) { // (a test replaces it)
function apg_http( $url, $headers = array(), $post = null, $timeout = 5 ) {
	$lines = array( 'user-agent: ' . APG_UA );
	foreach ( $headers as $name => $value ) {
		$lines[] = $name . ': ' . str_replace( array( "\r", "\n" ), '', (string) $value );
	}
	if ( function_exists( 'curl_init' ) ) {
		$c = curl_init( $url );
		curl_setopt_array( $c, array( CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => $timeout, CURLOPT_CONNECTTIMEOUT => min( 5, $timeout ), CURLOPT_HTTPHEADER => $lines ) );
		if ( null !== $post ) {
			curl_setopt( $c, CURLOPT_POST, true );
			curl_setopt( $c, CURLOPT_POSTFIELDS, $post );
		}
		$raw = curl_exec( $c );
		if ( false === $raw ) {
			curl_close( $c );
			return null;
		}
		$size   = (int) curl_getinfo( $c, CURLINFO_HEADER_SIZE );
		$status = (int) curl_getinfo( $c, CURLINFO_RESPONSE_CODE );
		curl_close( $c );
		return array( $status, apg_parse_headers( substr( (string) $raw, 0, $size ) ), (string) substr( (string) $raw, $size ) );
	}
	$ctx  = stream_context_create( array( 'http' => array( 'method' => null === $post ? 'GET' : 'POST', 'header' => implode( "\r\n", $lines ), 'content' => null === $post ? '' : $post, 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0 ) ) );
	$body = @file_get_contents( $url, false, $ctx );
	if ( function_exists( 'http_get_last_response_headers' ) ) {
		$rh = http_get_last_response_headers();
	} else {
		$var = 'http_response_header'; // by name: PHP 8.5 deprecates naming it directly
		$rh  = isset( $$var ) ? $$var : null;
	}
	if ( false === $body || ! is_array( $rh ) || ! $rh ) {
		return null;
	}
	$status = 0;
	if ( preg_match( '#^HTTP/\S+ (\d{3})#', (string) $rh[0], $m ) ) {
		$status = (int) $m[1];
	}
	return array( $status, apg_parse_headers( implode( "\r\n", $rh ) ), (string) $body );
}
}

function apg_parse_headers( $raw ) {
	$out = array();
	foreach ( preg_split( '/\r?\n/', $raw ) as $line ) {
		$p = strpos( $line, ':' );
		if ( false !== $p && $p > 0 ) {
			$out[ strtolower( trim( substr( $line, 0, $p ) ) ) ] = trim( substr( $line, $p + 1 ) );
		}
	}
	return $out;
}

/** The visitor's address. X-Forwarded-For counts only from one of your proxies (AIPAYGEN_TRUSTED_PROXIES). */
function apg_ip() {
	$remote  = isset( $_SERVER['REMOTE_ADDR'] ) ? (string) $_SERVER['REMOTE_ADDR'] : '';
	$trusted = defined( 'AIPAYGEN_TRUSTED_PROXIES' ) ? (string) AIPAYGEN_TRUSTED_PROXIES : (string) getenv( 'AIPAYGEN_TRUSTED_PROXIES' );
	$nets    = array_values( array_filter( array_map( 'trim', explode( ',', $trusted ) ) ) );
	if ( ! $nets || ! apg_in_list( $remote, $nets ) ) {
		return $remote;
	}
	$xff = array_reverse( array_values( array_filter( array_map( 'trim', explode( ',', apg_header( 'x-forwarded-for' ) ) ) ) ) );
	foreach ( $xff as $a ) {
		if ( filter_var( $a, FILTER_VALIDATE_IP ) && ! apg_in_list( $a, $nets ) ) {
			return $a;
		}
	}
	return $remote;
}

/** Is this address inside one of these ranges (bare addresses or a.b.c.d/n, IPv4 or IPv6)? */
function apg_in_list( $ip, $list ) {
	if ( ! filter_var( $ip, FILTER_VALIDATE_IP ) ) {
		return false;
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

/** Is this address one an AI crawler operator publishes? The list is kept a day; fetched after the visitor's response, never inside it. */
function apg_ai_ip( $ip ) {
	$list = apg_get( 'ai_ips' );
	if ( null === $list ) {
		apg_set( 'ai_ips', array(), 300 ); // a placeholder, so this is not asked again on every request
		register_shutdown_function( 'apg_refresh_ips' );
		$list = array();
	}
	return apg_in_list( $ip, $list );
}

function apg_after_response() {
	if ( function_exists( 'fastcgi_finish_request' ) ) {
		@fastcgi_finish_request();
	}
}

function apg_refresh_ips() {
	apg_after_response();
	$res  = apg_http( APG_GATEWAY . '/v1/ai_bot_ips?format=text', array(), null, 5 );
	$list = array();
	if ( $res && 200 === $res[0] ) {
		$list = array_values( array_filter( array_map( 'trim', explode( "\n", $res[2] ) ) ) );
	}
	apg_set( 'ai_ips', $list, $list ? 86400 : 300 );
}

/** This route's price quote, kept an hour (null if unavailable; a miss is remembered 5 minutes so crawler visits never each cause a lookup). */
function apg_quote( $route ) {
	static $mem = null;
	if ( null !== $mem ) {
		return $mem ?: null;
	}
	$q = apg_get( 'quote' );
	if ( is_array( $q ) && isset( $q['route'] ) && $q['route'] === $route ) {
		$mem = $q;
		return $q;
	}
	if ( apg_get( 'quote_miss' ) === $route ) {
		$mem = false;
		return null;
	}
	$res = apg_http( APG_GATEWAY . '/v1/gateway/quote/' . $route, array(), null, 5 );
	$q   = ( $res && 200 === $res[0] ) ? json_decode( $res[2], true ) : null;
	if ( ! is_array( $q ) || ( empty( $q['accepts'] ) && ( ! isset( $q['charge_mode'] ) || 'off' !== $q['charge_mode'] ) ) ) {
		apg_set( 'quote_miss', $route, 300 );
		$mem = false;
		return null;
	}
	$q['route'] = $route;
	apg_set( 'quote', $q, 3600 );
	$mem = $q;
	return $q;
}

/** The terms link a 402 (and a page served to an AI crawler) carries: only a plain https URL is used. */
function apg_terms_link( $q ) {
	$terms = is_array( $q ) && isset( $q['terms'] ) && is_string( $q['terms'] ) ? $q['terms'] : '';
	return preg_match( '#^https:[^\s<>"]+\z#', $terms ) ? '<' . $terms . '>; rel="ai-terms"' : '';
}

/** The terms' headers on a page served to an AI crawler: Link rel="ai-terms" and the IETF aipref Content-Usage. */
function apg_sign_page( $q ) {
	if ( ! is_array( $q ) ) {
		return;
	}
	$link = apg_terms_link( $q );
	if ( '' !== $link ) {
		apg_out( 'link: ' . $link, false );
	}
	if ( isset( $q['content_usage'] ) && is_string( $q['content_usage'] ) && preg_match( '/^[a-z-]+=[yn](, [a-z-]+=[yn]){0,5}\z/', $q['content_usage'] ) ) {
		apg_out( 'content-usage: ' . $q['content_usage'] );
	}
}

function apg_count( $bot, $path ) {
	apg_update(
		'counts',
		function ( $c ) use ( $bot, $path ) {
			$c = is_array( $c ) ? $c : array();
			$c['bots'][ $bot ] = ( isset( $c['bots'][ $bot ] ) ? (int) $c['bots'][ $bot ] : 0 ) + 1;
			if ( '' !== $path && ( isset( $c['paths'][ $path ] ) || count( isset( $c['paths'] ) ? $c['paths'] : array() ) < 300 ) ) {
				$c['paths'][ $path ] = ( isset( $c['paths'][ $path ] ) ? (int) $c['paths'][ $path ] : 0 ) + 1;
			}
			$c['n'] = ( isset( $c['n'] ) ? (int) $c['n'] : 0 ) + 1;
			return $c;
		},
		30 * 86400
	);
}

/** A verified crawler (its name AND an address its company publishes) reading the AI Terms file is counted too, up to 50 names. */
function apg_count_terms_read( $name ) {
	apg_update(
		'counts',
		function ( $c ) use ( $name ) {
			$c = is_array( $c ) ? $c : array();
			if ( isset( $c['terms'][ $name ] ) || count( isset( $c['terms'] ) ? $c['terms'] : array() ) < 50 ) {
				$c['terms'][ $name ] = ( isset( $c['terms'][ $name ] ) ? (int) $c['terms'][ $name ] : 0 ) + 1;
			}
			return $c;
		},
		30 * 86400
	);
}

/** The name a visit is counted under: "<name> (fake)" when its operator publishes addresses and the visit came from outside them. */
function apg_seen_as( $named, $verified, $route ) {
	if ( '' === $named ) {
		return 'AI crawler (by IP)';
	}
	$list = apg_get( 'ai_ips' );
	$q    = apg_quote( $route );
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

/** Once a day: delete state files nothing has touched for 3 days (old free-allowance counters, a quote or terms that is no longer asked for). */
function apg_prune() {
	if ( null !== apg_get( 'pruned' ) ) {
		return;
	}
	apg_set( 'pruned', 1, 86400 );
	$d = apg_dir();
	foreach ( (array) glob( $d . '/*.json' ) as $f ) {
		if ( is_file( $f ) && filemtime( $f ) < time() - 3 * 86400 ) {
			@unlink( $f );
		}
	}
}

/** Send the counts after the response has gone out: when enough has built up, hourly, or one empty report a day ("still installed"). */
function apg_send_if_due() {
	$route  = apg_route();
	$secret = apg_secret();
	if ( '' === $route || '' === $secret || '' === apg_dir() ) {
		return;
	}
	apg_prune();
	$meta = apg_get( 'meta' );
	$meta = is_array( $meta ) ? $meta : array( 'sent' => 0, 'hb' => 0 );
	$c    = apg_get( 'counts' );
	$n    = ( is_array( $c ) && isset( $c['n'] ) ) ? (int) $c['n'] : 0;
	$q    = apg_quote( $route );
	$rep  = ( is_array( $q ) && isset( $q['report'] ) && is_array( $q['report'] ) ) ? $q['report'] : array();
	$every = ( isset( $rep['every_seconds'] ) && is_numeric( $rep['every_seconds'] ) ) ? max( 60, (int) $rep['every_seconds'] ) : 3600;
	$max   = ( isset( $rep['max_hits'] ) && is_int( $rep['max_hits'] ) ) ? $rep['max_hits'] : 500;
	$due   = $n > 0 ? ( $n >= $max || time() - (int) $meta['sent'] >= $every ) : ( time() - (int) $meta['hb'] >= 86400 );
	if ( ! $due ) {
		return;
	}
	// Claim the send, so parallel requests send once; a failed send puts the counts back.
	$taken = null;
	apg_update(
		'counts',
		function ( $cur ) use ( &$taken ) {
			$taken = $cur;
			return array();
		},
		30 * 86400
	);
	apg_set( 'meta', array( 'sent' => time(), 'hb' => time() ), 40 * 86400 );
	$taken = is_array( $taken ) ? $taken : array();
	$paths = isset( $taken['paths'] ) && is_array( $taken['paths'] ) ? $taken['paths'] : array();
	arsort( $paths );
	$body = array( 'counts' => (object) ( isset( $taken['bots'] ) ? $taken['bots'] : array() ), 'paths' => (object) array_slice( $paths, 0, 10, true ) );
	if ( ! empty( $taken['terms'] ) ) {
		$body['terms'] = (object) $taken['terms'];
	}
	$res = apg_http( APG_GATEWAY . '/v1/gateway/hits/' . $route, array( 'content-type' => 'application/json', 'x-aipaygen-gateway-secret' => $secret ), json_encode( $body ), 8 );
	if ( ! $res || 200 !== $res[0] ) {
		apg_update(
			'counts',
			function ( $cur ) use ( $taken ) {
				$cur = is_array( $cur ) ? $cur : array();
				foreach ( isset( $taken['bots'] ) ? $taken['bots'] : array() as $k => $v ) {
					$cur['bots'][ $k ] = ( isset( $cur['bots'][ $k ] ) ? (int) $cur['bots'][ $k ] : 0 ) + (int) $v;
				}
				foreach ( isset( $taken['paths'] ) ? $taken['paths'] : array() as $k => $v ) {
					if ( isset( $cur['paths'][ $k ] ) || count( isset( $cur['paths'] ) ? $cur['paths'] : array() ) < 300 ) {
						$cur['paths'][ $k ] = ( isset( $cur['paths'][ $k ] ) ? (int) $cur['paths'][ $k ] : 0 ) + (int) $v;
					}
				}
				foreach ( isset( $taken['terms'] ) ? $taken['terms'] : array() as $k => $v ) {
					$cur['terms'][ $k ] = ( isset( $cur['terms'][ $k ] ) ? (int) $cur['terms'][ $k ] : 0 ) + (int) $v;
				}
				$cur['n'] = ( isset( $cur['n'] ) ? (int) $cur['n'] : 0 ) + ( isset( $taken['n'] ) ? (int) $taken['n'] : 0 );
				return $cur;
			},
			30 * 86400
		);
	}
}

function apg_send_after_response() {
	apg_after_response();
	try {
		apg_send_if_due();
	} catch ( \Throwable $e ) {
		// Never fatal: counts are only counts.
	}
}

function apg_json_exit( $code, $data, $extra = array() ) {
	apg_status( $code );
	apg_out( 'content-type: application/json' );
	foreach ( $extra as $k => $v ) {
		apg_out( $k . ': ' . $v );
	}
	echo json_encode( $data, JSON_UNESCAPED_SLASHES );
	exit;
}

/** The AI Terms file at /.well-known/ai-terms, from AIPayGen, kept 15 minutes. Serving it is also how AIPayGen sees this site is yours. */
function apg_serve_terms( $route, $ip ) {
	$ua = apg_header( 'user-agent' );
	if ( preg_match( APG_BOTS, $ua, $m ) && apg_ai_ip( $ip ) && '' !== apg_dir() ) {
		apg_count_terms_read( $m[0] );
	}
	$kept = apg_get( 'terms' );
	if ( ! is_array( $kept ) || ! isset( $kept['route'], $kept['body'] ) || $kept['route'] !== $route ) {
		$res  = apg_http( APG_GATEWAY . '/v1/gateway/terms/' . $route, array(), null, 3 );
		$body = ( $res && 200 === $res[0] ) ? $res[2] : '';
		$ok   = '' !== $body && strlen( $body ) <= 65536 && is_array( json_decode( $body, true ) );
		$kept = array( 'route' => $route, 'body' => $ok ? $body : '' );
		apg_set( 'terms', $kept, $ok ? 900 : 300 );
	}
	$terms = '' === $kept['body'] ? null : json_decode( $kept['body'], true );
	if ( ! is_array( $terms ) ) {
		return; // AIPayGen can't be reached: the site answers this address as it normally would.
	}
	apg_status( 200 );
	apg_out( 'content-type: application/json' );
	apg_out( 'cache-control: public, max-age=900' );
	apg_out( 'access-control-allow-origin: *' );
	echo json_encode( $terms, JSON_UNESCAPED_SLASHES );
	exit;
}

function apg_page_url( $path ) {
	$https = ( ! empty( $_SERVER['HTTPS'] ) && 'off' !== $_SERVER['HTTPS'] ) || ( isset( $_SERVER['SERVER_PORT'] ) && '443' === (string) $_SERVER['SERVER_PORT'] );
	$host  = isset( $_SERVER['HTTP_HOST'] ) ? preg_replace( '/[^A-Za-z0-9.:\[\]-]/', '', (string) $_SERVER['HTTP_HOST'] ) : '';
	return ( $https ? 'https://' : 'http://' ) . $host . $path;
}

/** Answer an unpaid AI crawler with 402 and the price, then stop. Returns when the page should be served (no quote, report only, free). */
function apg_local_402( $route, $url, $bot, $verified ) {
	$q = apg_quote( $route );
	if ( ! $q || ( isset( $q['charge_mode'] ) && 'off' === $q['charge_mode'] ) || empty( $q['accepts'] ) ) {
		return;
	}
	foreach ( ( isset( $q['free_bots'] ) && is_array( $q['free_bots'] ) ) ? $q['free_bots'] : array() as $free ) {
		if ( 0 === strcasecmp( (string) $free, (string) $bot ) ) {
			apg_sign_page( $q );
			return;
		}
	}
	$fa = ( isset( $q['free'] ) && is_array( $q['free'] ) ) ? $q['free'] : null;
	if ( $verified && $fa && isset( $fa['requests'] ) && (int) $fa['requests'] > 0 ) {
		$hourly = isset( $fa['per'] ) && 'hour' === $fa['per'];
		$key    = 'free_' . md5( strtolower( (string) $bot ) . '|' . gmdate( 'Y-m-d' ) . ( $hourly ? 'T' . gmdate( 'H' ) : '' ) );
		$used   = 0;
		apg_update(
			$key,
			function ( $cur ) use ( &$used ) {
				$used = (int) $cur + 1;
				return $used;
			},
			$hourly ? 7200 : 172800
		);
		if ( $used <= (int) $fa['requests'] ) {
			apg_sign_page( $q );
			return;
		}
	}
	$quote = array(
		'x402Version' => 2,
		'error'       => 'PAYMENT_REQUIRED',
		'resource'    => array( 'url' => $url, 'description' => isset( $q['description'] ) ? (string) $q['description'] : '', 'mimeType' => 'text/html' ),
		'accepts'     => $q['accepts'],
	);
	if ( isset( $q['extensions'] ) && is_array( $q['extensions'] ) && $q['extensions'] ) {
		$quote['extensions'] = $q['extensions'];
	}
	$extra = array( 'cache-control' => 'no-store', 'payment-required' => base64_encode( json_encode( $quote, JSON_UNESCAPED_SLASHES ) ) );
	$link  = apg_terms_link( $q );
	if ( '' !== $link ) {
		$extra['link'] = $link;
	}
	apg_json_exit( 402, array_merge( $quote, array( 'help' => isset( $q['help'] ) ? $q['help'] : null ) ), $extra );
}

/** A crawler retrying with a payment: AIPayGen verifies it, fetches the page and settles to your wallet. */
function apg_paid_retry( $route, $path, $sig, $xpay ) {
	$h = array( 'accept' => apg_header( 'accept' ) ? apg_header( 'accept' ) : '*/*', 'accept-language' => apg_header( 'accept-language' ) );
	if ( '' !== $sig ) {
		$h['payment-signature'] = $sig;
	}
	if ( '' !== $xpay ) {
		$h['x-payment'] = $xpay;
	}
	$h   = array_filter( $h, 'strlen' );
	$res = apg_http( APG_GATEWAY . '/g/' . $route . $path, $h, null, 25 );
	if ( ! $res ) {
		// A payment that can't be checked is not accepted, and the page is not given free.
		apg_json_exit( 503, array( 'error' => 'PAYMENT_GATEWAY_UNAVAILABLE', 'message' => 'The payment service could not be reached. Nothing was charged. Try again shortly.' ), array( 'retry-after' => '60', 'cache-control' => 'no-store' ) );
	}
	list( $code, $headers, $body ) = $res;
	$keep = array( 'payment-response', 'cache-control', 'link', 'x-aipaygen-charged', 'x-aipaygen-delivery' );
	$keep = array_merge( $keep, ( $code >= 200 && $code <= 299 ) ? array( 'content-usage', 'ai-purpose', 'x-aipaygen-review' ) : array( 'payment-required' ) );
	foreach ( $keep as $name ) {
		if ( isset( $headers[ $name ] ) && '' !== $headers[ $name ] ) {
			apg_out( $name . ': ' . str_replace( array( "\r", "\n" ), '', $headers[ $name ] ) );
		}
	}
	if ( $code >= 200 && $code <= 299 ) {
		return; // Paid: the site now serves the page itself, with the receipt header added. Nothing of the gateway's body is printed.
	}
	$answer = json_decode( $body, true );
	apg_json_exit( $code >= 400 ? $code : 502, is_array( $answer ) ? $answer : array( 'error' => 'gateway_error' ) );
}

function apg_run() {
	if ( 'cli' === PHP_SAPI || 'phpdbg' === PHP_SAPI ) {
		return;
	}
	apg_handle();
}

function apg_handle() {
	$route = apg_route();
	if ( '' === $route ) {
		return;
	}
	$secret = apg_secret();
	$ip     = apg_ip();
	$ua     = apg_header( 'user-agent' );
	$path   = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '/';
	if ( '' === $path || '/' !== $path[0] ) {
		$path = '/';
	}
	$clean = (string) parse_url( $path, PHP_URL_PATH );
	// The gateway fetching a page it was paid for: serve it.
	if ( '' !== $secret && hash_equals( $secret, apg_header( 'x-aipaygen-gateway-secret' ) ) ) {
		return;
	}
	if ( '/.well-known/ai-terms' === $clean ) {
		apg_serve_terms( $route, $ip );
		return;
	}
	// robots.txt is free for every crawler: it is how they learn your rules and find your terms.
	if ( '/robots.txt' === $clean ) {
		return;
	}
	$sig  = apg_header( 'payment-signature' );
	$xpay = apg_header( 'x-payment' );
	if ( '' !== $sig || '' !== $xpay ) {
		apg_paid_retry( $route, $path, $sig, $xpay );
		return;
	}
	if ( preg_match( '/\.(css|js|mjs|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|map)$/i', $clean ) ) {
		return;
	}
	$named = preg_match( APG_BOTS, $ua, $m ) ? $m[0] : '';
	$bot   = '' !== $named ? $named : ( apg_ai_ip( $ip ) ? 'AI crawler (by IP)' : '' );
	register_shutdown_function( 'apg_send_after_response' );
	if ( '' === $bot ) {
		return; // People and search engines browse free.
	}
	// Verified: its name AND its address match the lists AI companies publish. Only verified crawlers get the free allowance.
	$verified = '' !== $named && apg_ai_ip( $ip );
	apg_count( apg_seen_as( $named, $verified, $route ), $clean );
	apg_local_402( $route, apg_page_url( $path ), $bot, $verified );
	// No quote, report only, or within the free allowance: the page is served as usual.
}

if ( ! defined( 'AIPAYGEN_NO_RUN' ) ) {
	try {
		apg_run();
	} catch ( \Throwable $e ) {
		// Fail open: an error in this file must never take the site down; the page is served as if it were not here.
		if ( apg_header( 'payment-signature' ) !== '' || apg_header( 'x-payment' ) !== '' ) {
			apg_json_exit( 503, array( 'error' => 'PAYMENT_GATEWAY_UNAVAILABLE', 'message' => 'The payment service could not be reached. Nothing was charged. Try again shortly.' ), array( 'retry-after' => '60', 'cache-control' => 'no-store' ) );
		}
	}
}
