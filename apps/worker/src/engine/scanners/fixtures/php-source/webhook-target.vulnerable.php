<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$destination = $_POST['callback'];
$curl = curl_init($destination);
