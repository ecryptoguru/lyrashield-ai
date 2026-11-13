<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$xml = $_POST['xml'];
$document = simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NONET);
