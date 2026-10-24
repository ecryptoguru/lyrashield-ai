<?php
// security-scan-skip-file: intentional passive scanner benchmark data
$page = ['help' => '/srv/pages/help.php', 'about' => '/srv/pages/about.php'][$_GET['page']];
include $page;
