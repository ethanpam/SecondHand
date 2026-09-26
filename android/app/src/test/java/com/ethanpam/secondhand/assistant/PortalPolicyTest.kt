package com.ethanpam.secondhand.assistant

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PortalPolicyTest {
    @Test fun navigationPermitsOnlyTheIowaPortal() {
        assertTrue(AssistantController.allowedNavigation(AssistantController.PORTAL))
        assertTrue(AssistantController.allowedNavigation(AssistantController.PORTAL + "/applyForBenefits/guestLogin"))
        // Website navigation can contain its own query; the stricter native data-release policy excludes it.
        assertTrue(AssistantController.allowedNavigation(AssistantController.PORTAL + "?page=1"))
        for (url in listOf(null, "", "http://hhsservices.iowa.gov/apspssp/ssp.portal",
            "https://hhsservices.iowa.gov.evil.test/apspssp/ssp.portal",
            "https://user@hhsservices.iowa.gov/apspssp/ssp.portal", "https://hhsservices.iowa.gov:444/apspssp/ssp.portal",
            "https://hhsservices.iowa.gov/other", "https://hhsservices.iowa.gov/apspssp/../other",
            "https://hhsservices.iowa.gov/apspssp/%2e%2e/other", "file:///apspssp/ssp.portal",
            "javascript:alert(1)", " " + AssistantController.PORTAL)) {
            assertFalse(url ?: "null", AssistantController.allowedNavigation(url))
        }
    }
}
