<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$destination = ['events' => 'https://events.example.test/ingest'][$_POST['channel']];
$curl = curl_init($destination);
