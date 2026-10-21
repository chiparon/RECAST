"""Domain data for this module."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class CommerceTaxCalculationData:
    """计算商品、配送和支付附加费用的含税及未税价格，判断客户免税条件，管理税务类别并校验 VAT 号码，返回 VAT 状态和识别到的企业信息。"""
    customer_id: int
    country_code: str
    vat_number: str
    price: float
    tax_rate: float
    including_tax: bool
