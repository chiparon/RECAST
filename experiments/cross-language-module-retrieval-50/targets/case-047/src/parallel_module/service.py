"""计算商品、配送和支付附加费用的含税及未税价格，判断客户免税条件，管理税务类别并校验 VAT 号码，返回 VAT 状态和识别到的企业信息。"""
from __future__ import annotations
from .contracts import CommerceTaxCalculationContract
from .models import CommerceTaxCalculationData

class CommerceTaxCalculation(CommerceTaxCalculationContract):
    def get_product_price(self, product: CommerceTaxCalculationData, price: float, customer: CommerceTaxCalculationData) -> CommerceTaxCalculationData:
        raise NotImplementedError("Business implementation pending")

    def get_shipping_price(self, price: float, customer: CommerceTaxCalculationData) -> CommerceTaxCalculationData:
        raise NotImplementedError("Business implementation pending")

    def is_tax_exempt(self, product: CommerceTaxCalculationData, customer: CommerceTaxCalculationData) -> bool:
        raise NotImplementedError("Business implementation pending")

    def check_vat(self, country_code: str, vat_number: str) -> CommerceTaxCalculationData:
        raise NotImplementedError("Business implementation pending")

