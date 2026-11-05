<?php
// devmagic-panel: PHP's settings and modules as JSON, for the panel's PHP info.
// Installed root-owned in /usr/local/lib/devmagic-panel/php and served only by
// the panel's own vhost to this computer; the command line gets it on stdin.
// Settings that look like a password never leave: their value is left out.
if ( PHP_SAPI !== 'cli' ) {
	if ( ( isset( $_SERVER['HTTP_X_DEVMAGIC_PANEL'] ) ? $_SERVER['HTTP_X_DEVMAGIC_PANEL'] : '' ) !== 'info' ) {
		http_response_code( 404 );
		exit;
	}
	header( 'Content-Type: application/json' );
	header( 'Cache-Control: no-store' );
}
$dmp_secret = '/(^|[._])(pw|pass|passwd|password|secret|token|key)($|[._])/i';
$dmp_ini    = array();
foreach ( ini_get_all( null, true ) as $dmp_name => $dmp_value ) {
	$dmp_hide              = preg_match( $dmp_secret, $dmp_name ) || ( 'session.save_path' === $dmp_name && false !== stripos( (string) $dmp_value['local_value'], 'auth' ) );
	$dmp_ini[ $dmp_name ] = array(
		'local'  => $dmp_hide ? '(hidden)' : (string) $dmp_value['local_value'],
		'master' => $dmp_hide ? '(hidden)' : (string) $dmp_value['global_value'],
	);
}
$dmp_groups     = array();
$dmp_extensions = array();
foreach ( get_loaded_extensions() as $dmp_ext ) {
	$dmp_extensions[ $dmp_ext ] = (string) phpversion( $dmp_ext );
	$dmp_own                    = @ini_get_all( $dmp_ext, false );
	if ( is_array( $dmp_own ) && count( $dmp_own ) > 0 ) {
		$dmp_groups[ $dmp_ext ] = array_keys( $dmp_own );
	}
}
$dmp_scanned = php_ini_scanned_files();
$dmp_out     = array(
	'version'        => PHP_VERSION,
	'sapi'           => PHP_SAPI,
	'iniFile'        => (string) php_ini_loaded_file(),
	'scannedFiles'   => $dmp_scanned ? array_values( array_filter( array_map( 'trim', explode( ',', $dmp_scanned ) ) ) ) : array(),
	'ini'            => $dmp_ini,
	'groups'         => $dmp_groups,
	'extensions'     => $dmp_extensions,
	'zendExtensions' => get_loaded_extensions( true ),
);
if ( extension_loaded( 'xdebug' ) ) {
	$dmp_modes        = function_exists( 'xdebug_info' ) ? @xdebug_info( 'mode' ) : array();
	$dmp_out['xdebug'] = array(
		'version' => (string) phpversion( 'xdebug' ),
		'modes'   => is_array( $dmp_modes ) ? array_values( $dmp_modes ) : array(),
	);
}
echo json_encode( $dmp_out, JSON_UNESCAPED_SLASHES | JSON_PARTIAL_OUTPUT_ON_ERROR );
