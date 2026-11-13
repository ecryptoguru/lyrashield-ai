<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$path = ['summary' => '/srv/reports/summary.pdf', 'detail' => '/srv/reports/detail.pdf'][$_GET['report']];
readfile($path);
